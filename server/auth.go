package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const loginHTML = `<!DOCTYPE html>
<html>
<head><title>Mineo Login</title>
<style>
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #282c34; color: #abb2bf; }
  form { display: flex; flex-direction: column; gap: 12px; }
  input[type=password] { padding: 8px; border-radius: 4px; border: 1px solid #4b5263; background: #1e2127; color: #abb2bf; }
  button { padding: 8px 16px; border-radius: 4px; border: none; background: #61afef; color: #282c34; cursor: pointer; font-weight: bold; }
  .error { color: #e06c75; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h2>Mineo</h2>
    %s
    <input type="password" name="password" placeholder="Password" autofocus />
    <button type="submit">Login</button>
  </form>
</body>
</html>`

const (
	sessionCookieName = "mineo_session"
	sessionMaxAge     = 7 * 24 * 60 * 60 // 7 days in seconds
)

// SessionStore is a simple in-memory session store.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]sessionData
	secret   []byte
}

type sessionData struct {
	authenticated bool
	expires       time.Time
}

// NewSessionStore creates a new session store.
func NewSessionStore(secret string) *SessionStore {
	return &SessionStore{
		sessions: make(map[string]sessionData),
		secret:   []byte(secret),
	}
}

// createSession creates a new authenticated session and returns the cookie value.
func (s *SessionStore) createSession() string {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := uuid.New().String()
	s.sessions[id] = sessionData{
		authenticated: true,
		expires:       time.Now().Add(time.Duration(sessionMaxAge) * time.Second),
	}

	// Sign the session ID
	return s.sign(id)
}

// validateSession checks if a cookie value corresponds to a valid, authenticated session.
func (s *SessionStore) validateSession(cookieValue string) bool {
	id, ok := s.unsign(cookieValue)
	if !ok {
		return false
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	sess, exists := s.sessions[id]
	if !exists {
		return false
	}
	if time.Now().After(sess.expires) {
		return false
	}
	return sess.authenticated
}

// sign creates an HMAC-signed cookie value.
func (s *SessionStore) sign(id string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(id))
	sig := base64.URLEncoding.EncodeToString(mac.Sum(nil))
	return id + "." + sig
}

// unsign verifies and extracts the session ID from a signed cookie value.
func (s *SessionStore) unsign(value string) (string, bool) {
	idx := strings.LastIndex(value, ".")
	if idx == -1 {
		return "", false
	}
	id := value[:idx]
	sig := value[idx+1:]

	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(id))
	expected := base64.URLEncoding.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return "", false
	}
	return id, true
}

// cleanup removes expired sessions (call periodically).
func (s *SessionStore) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, sess := range s.sessions {
		if now.After(sess.expires) {
			delete(s.sessions, id)
		}
	}
}

// AuthMiddleware wraps an http.Handler and enforces authentication.
// If no password is configured, it passes through all requests.
type AuthMiddleware struct {
	password string
	store    *SessionStore
	next     http.Handler
}

// NewAuthMiddleware creates auth middleware. Returns nil if no password.
func NewAuthMiddleware(password string, store *SessionStore, next http.Handler) http.Handler {
	if password == "" {
		return next
	}
	return &AuthMiddleware{
		password: password,
		store:    store,
		next:     next,
	}
}

func (am *AuthMiddleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// Always exempt healthz and login
	if path == "/healthz" || path == "/login" {
		am.next.ServeHTTP(w, r)
		return
	}

	// Check session cookie
	cookie, err := r.Cookie(sessionCookieName)
	if err == nil && am.store.validateSession(cookie.Value) {
		am.next.ServeHTTP(w, r)
		return
	}

	// Not authenticated — redirect to login
	http.Redirect(w, r, "/login", http.StatusFound)
}

// ── Login rate limiting ───────────────────────────────────────────────────────

type loginAttempt struct {
	count     int
	windowEnd time.Time
}

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempt
}

var globalLoginLimiter = &loginLimiter{attempts: make(map[string]*loginAttempt)}

const (
	loginMaxAttempts = 10
	loginWindow      = 15 * time.Minute
	loginBanDuration = 30 * time.Minute
)

// allowed returns true if the IP is not currently rate-limited.
func (l *loginLimiter) allowed(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[ip]
	if !ok {
		return true
	}
	if time.Now().After(a.windowEnd) {
		delete(l.attempts, ip)
		return true
	}
	return a.count < loginMaxAttempts
}

// recordFailure increments the failure count for the IP.
func (l *loginLimiter) recordFailure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[ip]
	if !ok || time.Now().After(a.windowEnd) {
		l.attempts[ip] = &loginAttempt{count: 1, windowEnd: time.Now().Add(loginWindow)}
		return
	}
	a.count++
	// Once the threshold is hit, extend the window into a ban period
	if a.count >= loginMaxAttempts {
		a.windowEnd = time.Now().Add(loginBanDuration)
	}
}

// resetIP clears failure records for the IP on successful login.
func (l *loginLimiter) resetIP(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}

// startLoginLimiterCleanup starts a background goroutine that periodically
// removes expired attempt records to prevent unbounded memory growth.
func startLoginLimiterCleanup() {
	go func() {
		for {
			time.Sleep(1 * time.Hour)
			globalLoginLimiter.mu.Lock()
			now := time.Now()
			for ip, a := range globalLoginLimiter.attempts {
				if now.After(a.windowEnd) {
					delete(globalLoginLimiter.attempts, ip)
				}
			}
			globalLoginLimiter.mu.Unlock()
		}
	}()
}

// realIP extracts the real client IP, respecting X-Forwarded-For when the
// direct connection comes from a loopback address (i.e. a trusted local proxy).
func realIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			if candidate := strings.TrimSpace(parts[0]); candidate != "" {
				return candidate
			}
		}
	}
	return host
}

// RegisterAuth sets up /login GET and POST routes on the mux.
// Returns the session store (needed for WS auth), or nil if no password.
func RegisterAuth(mux *http.ServeMux, password string, secret string) *SessionStore {
	if password == "" {
		return nil
	}

	store := NewSessionStore(secret)

	// Periodic session cleanup
	go func() {
		for {
			time.Sleep(1 * time.Hour)
			store.cleanup()
		}
	}()

	// Periodic login-limiter cleanup
	startLoginLimiterCleanup()

	// GET /login — serve login form
	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, loginHTML, "")
	})

	// POST /login — handle form submission
	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Bad request", http.StatusBadRequest)
			return
		}

		ip := realIP(r)
		if !globalLoginLimiter.allowed(ip) {
			http.Error(w, "Too many login attempts — try again later", http.StatusTooManyRequests)
			return
		}

		if r.FormValue("password") == password {
			globalLoginLimiter.resetIP(ip)
			cookieValue := store.createSession()
			http.SetCookie(w, &http.Cookie{
				Name:     sessionCookieName,
				Value:    cookieValue,
				Path:     "/",
				MaxAge:   sessionMaxAge,
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
			})
			http.Redirect(w, r, "/", http.StatusFound)
		} else {
			globalLoginLimiter.recordFailure(ip)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprintf(w, loginHTML, `<p class="error">Incorrect password</p>`)
		}
	})

	return store
}

// AuthorizeWS checks if a WebSocket upgrade request has a valid session.
// Returns true if authentication is not required or session is valid.
func AuthorizeWS(r *http.Request, store *SessionStore) bool {
	if store == nil {
		return true
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return false
	}
	return store.validateSession(cookie.Value)
}
