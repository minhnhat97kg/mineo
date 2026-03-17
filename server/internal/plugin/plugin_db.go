package plugin

// plugin_db.go — Database plugin for Mineo IDE
//
// Supports PostgreSQL, MySQL/MariaDB, SQLite, and MongoDB.
// Connections: Direct TCP, SSH password tunnel, SSH key tunnel.
// Passwords are encrypted with AES-256-GCM (key = SHA-256 of cfg.Secret).

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/lib/pq"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"golang.org/x/crypto/ssh"
	_ "modernc.org/sqlite"

	"mineo/server/internal/config"
)

// ── Plugin registration ───────────────────────────────────────────────────────

func init() {
	RegisterPlugin(&DBPlugin{conns: make(map[string]*liveConn)})
}

// ── Types ─────────────────────────────────────────────────────────────────────

// StoredConnection holds metadata for a saved DB connection (no passwords).
type StoredConnection struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	Driver     string    `json:"driver"` // postgres | mysql | sqlite | mongo
	Method     string    `json:"method"` // direct | ssh | ssh-key
	Host       string    `json:"host"`
	Port       int       `json:"port"`
	Database   string    `json:"database"`
	User       string    `json:"user"`
	SSLMode    string    `json:"sslMode"` // disable | require | verify-full
	FilePath   string    `json:"filePath"`
	SSHHost    string    `json:"sshHost"`
	SSHPort    int       `json:"sshPort"`
	SSHUser    string    `json:"sshUser"`
	SSHKeyPath string    `json:"sshKeyPath"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// connectionsFile is the on-disk format for db-connections.json.
type connectionsFile struct {
	Connections []StoredConnection `json:"connections"`
}

// liveConn represents an active (open) database connection.
type liveConn struct {
	driver         string
	db             *sql.DB       // nil for mongo
	mongoClient    *mongo.Client // nil for SQL
	mongoDB        string
	sshClient      *ssh.Client
	tunnelListener net.Listener
}

// DBPlugin is the server-side plugin implementation.
type DBPlugin struct {
	mu    sync.RWMutex
	conns map[string]*liveConn
}

func (p *DBPlugin) Name() string { return "db" }

// ── Helpers: file paths ───────────────────────────────────────────────────────

func dbConnsPath(cfg *config.MineoCfg) string {
	cfg.Mu.RLock()
	defer cfg.Mu.RUnlock()
	return filepath.Join(filepath.Dir(os.Getenv("MINEO_CONFIG_DIR_HINT")), "db-connections.json")
}

// configDir returns the directory containing config.json. We stash it at
// init-time so we don't depend on the env var trick.
var dbConfigDir string

func (p *DBPlugin) connsPath() string {
	return filepath.Join(dbConfigDir, "db-connections.json")
}

func (p *DBPlugin) secretsPath() string {
	return filepath.Join(dbConfigDir, ".db-secrets")
}

// ── Helpers: encryption ───────────────────────────────────────────────────────

// deriveKey returns the 32-byte AES key from the Mineo session secret.
func deriveKey(secret string) []byte {
	h := sha256.Sum256([]byte(secret))
	return h[:]
}

// encryptSecrets serialises secrets map to JSON then encrypts with AES-256-GCM.
// Output: base64(nonce[12] + ciphertext).
func encryptSecrets(secrets map[string]string, key []byte) (string, error) {
	plain, err := json.Marshal(secrets)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nonce, nonce, plain, nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// decryptSecrets reverses encryptSecrets.
func decryptSecrets(encoded string, key []byte) (map[string]string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	if len(data) < gcm.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := data[:gcm.NonceSize()], data[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}

	var secrets map[string]string
	if err := json.Unmarshal(plain, &secrets); err != nil {
		return nil, err
	}
	return secrets, nil
}

// ── Helpers: load / save connections ─────────────────────────────────────────

func (p *DBPlugin) loadConnections() ([]StoredConnection, error) {
	data, err := os.ReadFile(p.connsPath())
	if os.IsNotExist(err) {
		return []StoredConnection{}, nil
	}
	if err != nil {
		return nil, err
	}
	var f connectionsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if f.Connections == nil {
		f.Connections = []StoredConnection{}
	}
	return f.Connections, nil
}

func (p *DBPlugin) saveConnections(conns []StoredConnection) error {
	f := connectionsFile{Connections: conns}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p.connsPath(), append(data, '\n'), 0644)
}

// ── Helpers: load / save secrets ─────────────────────────────────────────────

func (p *DBPlugin) loadSecrets(key []byte) (map[string]string, error) {
	data, err := os.ReadFile(p.secretsPath())
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	encoded := strings.TrimSpace(string(data))
	if encoded == "" {
		return map[string]string{}, nil
	}
	return decryptSecrets(encoded, key)
}

func (p *DBPlugin) saveSecrets(secrets map[string]string, key []byte) error {
	encoded, err := encryptSecrets(secrets, key)
	if err != nil {
		return err
	}
	return os.WriteFile(p.secretsPath(), []byte(encoded), 0600)
}

// ── SSH tunnel ────────────────────────────────────────────────────────────────

// openSSHTunnel creates an SSH tunnel to dbHost:dbPort via sshHost:sshPort.
// Returns the sshClient, a local listener (on 127.0.0.1:0), and the local address.
func openSSHTunnel(conn *StoredConnection, sshPass, dbHost string, dbPort int) (*ssh.Client, net.Listener, string, error) {
	var authMethods []ssh.AuthMethod

	if conn.Method == "ssh-key" {
		keyData, err := os.ReadFile(conn.SSHKeyPath)
		if err != nil {
			return nil, nil, "", fmt.Errorf("read SSH key: %w", err)
		}
		signer, err := ssh.ParsePrivateKey(keyData)
		if err != nil {
			return nil, nil, "", fmt.Errorf("parse SSH key: %w", err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	} else {
		authMethods = append(authMethods, ssh.Password(sshPass))
	}

	sshPort := conn.SSHPort
	if sshPort == 0 {
		sshPort = 22
	}
	sshAddr := fmt.Sprintf("%s:%d", conn.SSHHost, sshPort)

	sshCfg := &ssh.ClientConfig{
		User:            conn.SSHUser,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // user-managed tunnels
		Timeout:         15 * time.Second,
	}

	sshClient, err := ssh.Dial("tcp", sshAddr, sshCfg)
	if err != nil {
		return nil, nil, "", fmt.Errorf("SSH dial %s: %w", sshAddr, err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = sshClient.Close()
		return nil, nil, "", fmt.Errorf("local listener: %w", err)
	}

	// Goroutine: forward local connections through the SSH tunnel.
	go func() {
		target := fmt.Sprintf("%s:%d", dbHost, dbPort)
		for {
			local, err := ln.Accept()
			if err != nil {
				return // listener closed
			}
			go func(local net.Conn) {
				remote, err := sshClient.Dial("tcp", target)
				if err != nil {
					_ = local.Close()
					return
				}
				go func() { _, _ = io.Copy(remote, local); _ = remote.Close() }()
				go func() { _, _ = io.Copy(local, remote); _ = local.Close() }()
			}(local)
		}
	}()

	return sshClient, ln, ln.Addr().String(), nil
}

// ── DSN builders ─────────────────────────────────────────────────────────────

func buildDSN(conn *StoredConnection, password, host string) string {
	switch conn.Driver {
	case "postgres":
		sslMode := conn.SSLMode
		if sslMode == "" {
			sslMode = "disable"
		}
		return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
			host, conn.Port, conn.User, password, conn.Database, sslMode)
	case "mysql":
		return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true",
			conn.User, password, host, conn.Port, conn.Database)
	case "sqlite":
		return conn.FilePath
	default:
		return ""
	}
}

// ── Open live connection ──────────────────────────────────────────────────────

func (p *DBPlugin) openConnection(cfg *config.MineoCfg, conn *StoredConnection, password, sshPass string) (*liveConn, error) {
	cfg.Mu.RLock()
	secret := cfg.Secret
	cfg.Mu.RUnlock()

	_ = secret // used indirectly via deriveKey when loading from stored secrets

	var sshClient *ssh.Client
	var tunnelListener net.Listener
	host := conn.Host

	if conn.Method == "ssh" || conn.Method == "ssh-key" {
		dbPort := conn.Port
		if conn.Driver == "sqlite" {
			return nil, fmt.Errorf("SSH tunnel not supported for SQLite")
		}
		var localAddr string
		var err error
		sshClient, tunnelListener, localAddr, err = openSSHTunnel(conn, sshPass, conn.Host, dbPort)
		if err != nil {
			return nil, err
		}
		// Extract just the host:port from the local listener address,
		// replacing the port in the DSN.
		parts := strings.Split(localAddr, ":")
		host = "127.0.0.1"
		if len(parts) == 2 {
			// Update conn port for DSN building
			_ = parts[1] // port is in localAddr; build a temp conn copy
		}
		// We need to pass the local address into the DSN builders, but those
		// builders use conn.Port.  Create a shallow copy of conn with the tunnel port.
		var portConn StoredConnection = *conn
		_, portStr, _ := net.SplitHostPort(localAddr)
		if portStr != "" {
			_, _ = fmt.Sscanf(portStr, "%d", &portConn.Port)
		}
		conn = &portConn
		_ = host
	}

	lc := &liveConn{
		driver:         conn.Driver,
		sshClient:      sshClient,
		tunnelListener: tunnelListener,
	}

	if conn.Driver == "mongo" {
		mongoHost := conn.Host
		mongoPort := conn.Port
		if mongoPort == 0 {
			mongoPort = 27017
		}
		if conn.Method == "ssh" || conn.Method == "ssh-key" {
			// Use the tunnel listener address
			addr := tunnelListener.Addr().String()
			mongoHost = addr
		}

		var uri string
		if conn.User != "" {
			uri = fmt.Sprintf("mongodb://%s:%s@%s:%d/%s",
				conn.User, password, mongoHost, mongoPort, conn.Database)
		} else {
			uri = fmt.Sprintf("mongodb://%s:%d", mongoHost, mongoPort)
		}
		if conn.Method == "ssh" || conn.Method == "ssh-key" {
			// Tunnel: address is already host:port
			uri = fmt.Sprintf("mongodb://%s", tunnelListener.Addr().String())
			if conn.User != "" {
				uri = fmt.Sprintf("mongodb://%s:%s@%s/%s",
					conn.User, password, tunnelListener.Addr().String(), conn.Database)
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		clientOpts := options.Client().ApplyURI(uri).SetConnectTimeout(10 * time.Second)
		mongoClient, err := mongo.Connect(ctx, clientOpts)
		if err != nil {
			if sshClient != nil {
				_ = sshClient.Close()
			}
			if tunnelListener != nil {
				_ = tunnelListener.Close()
			}
			return nil, fmt.Errorf("mongo connect: %w", err)
		}
		if err := mongoClient.Ping(ctx, nil); err != nil {
			_ = mongoClient.Disconnect(ctx)
			if sshClient != nil {
				_ = sshClient.Close()
			}
			if tunnelListener != nil {
				_ = tunnelListener.Close()
			}
			return nil, fmt.Errorf("mongo ping: %w", err)
		}
		lc.mongoClient = mongoClient
		lc.mongoDB = conn.Database
		return lc, nil
	}

	// SQL drivers
	var driverName string
	switch conn.Driver {
	case "postgres":
		driverName = "postgres"
	case "mysql":
		driverName = "mysql"
	case "sqlite":
		driverName = "sqlite"
	default:
		return nil, fmt.Errorf("unknown driver: %s", conn.Driver)
	}

	dsn := buildDSN(conn, password, host)
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		if sshClient != nil {
			_ = sshClient.Close()
		}
		if tunnelListener != nil {
			_ = tunnelListener.Close()
		}
		return nil, fmt.Errorf("open %s: %w", conn.Driver, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		if sshClient != nil {
			_ = sshClient.Close()
		}
		if tunnelListener != nil {
			_ = tunnelListener.Close()
		}
		return nil, fmt.Errorf("ping %s: %w", conn.Driver, err)
	}

	lc.db = db
	return lc, nil
}

// closeLiveConn tears down a live connection and its optional SSH tunnel.
func closeLiveConn(lc *liveConn) {
	if lc == nil {
		return
	}
	if lc.db != nil {
		_ = lc.db.Close()
	}
	if lc.mongoClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = lc.mongoClient.Disconnect(ctx)
	}
	if lc.tunnelListener != nil {
		_ = lc.tunnelListener.Close()
	}
	if lc.sshClient != nil {
		_ = lc.sshClient.Close()
	}
}

// ── Schema queries ────────────────────────────────────────────────────────────

type schemaColumn struct {
	Name     string `json:"name"`
	DataType string `json:"dataType"`
}

type schemaTable struct {
	Name    string         `json:"name"`
	Type    string         `json:"type"` // table | view | collection
	Columns []schemaColumn `json:"columns"`
}

type schemaDatabase struct {
	Name   string        `json:"name"`
	Tables []schemaTable `json:"tables"`
}

func fetchSchema(lc *liveConn) ([]schemaDatabase, error) {
	switch lc.driver {
	case "postgres":
		return fetchSchemaPostgres(lc.db)
	case "mysql":
		return fetchSchemaMySQL(lc.db)
	case "sqlite":
		return fetchSchemaSQLite(lc.db)
	case "mongo":
		return fetchSchemaMongo(lc.mongoClient, lc.mongoDB)
	default:
		return nil, fmt.Errorf("unknown driver: %s", lc.driver)
	}
}

func fetchSchemaPostgres(db *sql.DB) ([]schemaDatabase, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT t.table_schema, t.table_name, t.table_type,
		       c.column_name, c.data_type
		FROM information_schema.tables t
		JOIN information_schema.columns c
		  ON c.table_schema = t.table_schema AND c.table_name = t.table_name
		WHERE t.table_schema NOT IN ('pg_catalog','information_schema')
		ORDER BY t.table_schema, t.table_name, c.ordinal_position
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type key struct{ schema, table string }
	schemas := map[string]bool{}
	tables := map[key]*schemaTable{}
	var order []key

	for rows.Next() {
		var schemaName, tableName, tableType, colName, dataType string
		if err := rows.Scan(&schemaName, &tableName, &tableType, &colName, &dataType); err != nil {
			continue
		}
		schemas[schemaName] = true
		k := key{schemaName, tableName}
		if _, ok := tables[k]; !ok {
			tType := "table"
			if strings.Contains(strings.ToUpper(tableType), "VIEW") {
				tType = "view"
			}
			tables[k] = &schemaTable{Name: tableName, Type: tType}
			order = append(order, k)
		}
		tables[k].Columns = append(tables[k].Columns, schemaColumn{Name: colName, DataType: dataType})
	}

	// Group by schema
	schemaMap := map[string]*schemaDatabase{}
	var schemaOrder []string
	for _, k := range order {
		if _, ok := schemaMap[k.schema]; !ok {
			schemaMap[k.schema] = &schemaDatabase{Name: k.schema}
			schemaOrder = append(schemaOrder, k.schema)
		}
		schemaMap[k.schema].Tables = append(schemaMap[k.schema].Tables, *tables[k])
	}

	result := make([]schemaDatabase, 0, len(schemaOrder))
	for _, s := range schemaOrder {
		result = append(result, *schemaMap[s])
	}
	return result, nil
}

func fetchSchemaMySQL(db *sql.DB) ([]schemaDatabase, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT t.TABLE_NAME, t.TABLE_TYPE,
		       c.COLUMN_NAME, c.DATA_TYPE
		FROM information_schema.TABLES t
		JOIN information_schema.COLUMNS c
		  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
		WHERE t.TABLE_SCHEMA = DATABASE()
		ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tableMap := map[string]*schemaTable{}
	var tableOrder []string

	for rows.Next() {
		var tableName, tableType, colName, dataType string
		if err := rows.Scan(&tableName, &tableType, &colName, &dataType); err != nil {
			continue
		}
		if _, ok := tableMap[tableName]; !ok {
			tType := "table"
			if strings.Contains(strings.ToUpper(tableType), "VIEW") {
				tType = "view"
			}
			tableMap[tableName] = &schemaTable{Name: tableName, Type: tType}
			tableOrder = append(tableOrder, tableName)
		}
		tableMap[tableName].Columns = append(tableMap[tableName].Columns, schemaColumn{Name: colName, DataType: dataType})
	}

	tables := make([]schemaTable, 0, len(tableOrder))
	for _, name := range tableOrder {
		tables = append(tables, *tableMap[name])
	}
	return []schemaDatabase{{Name: "database", Tables: tables}}, nil
}

func fetchSchemaSQLite(db *sql.DB) ([]schemaDatabase, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rows, err := db.QueryContext(ctx, `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
	if err != nil {
		return nil, err
	}

	var objects []struct{ name, typ string }
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			continue
		}
		objects = append(objects, struct{ name, typ string }{name, typ})
	}
	rows.Close()

	var tables []schemaTable
	for _, obj := range objects {
		t := schemaTable{Name: obj.name, Type: obj.typ}
		cols, err := db.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%q)", obj.name))
		if err == nil {
			for cols.Next() {
				var cid int
				var cname, ctype string
				var notNull, pk int
				var dfltVal interface{}
				_ = cols.Scan(&cid, &cname, &ctype, &notNull, &dfltVal, &pk)
				t.Columns = append(t.Columns, schemaColumn{Name: cname, DataType: ctype})
			}
			cols.Close()
		}
		tables = append(tables, t)
	}
	return []schemaDatabase{{Name: "main", Tables: tables}}, nil
}

func fetchSchemaMongo(client *mongo.Client, dbName string) ([]schemaDatabase, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	mdb := client.Database(dbName)
	names, err := mdb.ListCollectionNames(ctx, bson.D{})
	if err != nil {
		return nil, err
	}

	var tables []schemaTable
	for _, name := range names {
		t := schemaTable{Name: name, Type: "collection"}
		// Sample one document to infer field names/types
		coll := mdb.Collection(name)
		var sample bson.M
		if err := coll.FindOne(ctx, bson.D{}).Decode(&sample); err == nil {
			for k, v := range sample {
				typeName := fmt.Sprintf("%T", v)
				// Simplify Go type names to something readable
				switch v.(type) {
				case int32, int64, float64:
					typeName = "number"
				case string:
					typeName = "string"
				case bool:
					typeName = "bool"
				case primitive_array:
					typeName = "array"
				default:
					typeName = strings.TrimPrefix(typeName, "primitive.")
				}
				t.Columns = append(t.Columns, schemaColumn{Name: k, DataType: typeName})
			}
		}
		tables = append(tables, t)
	}
	return []schemaDatabase{{Name: dbName, Tables: tables}}, nil
}

// primitive_array is a type alias to avoid importing primitive package just for the type switch.
type primitive_array = []interface{}

// ── Query execution ───────────────────────────────────────────────────────────

type queryResult struct {
	Columns    []string        `json:"columns"`
	Rows       [][]interface{} `json:"rows"`
	RowCount   int             `json:"rowCount"`
	DurationMs int64           `json:"durationMs"`
	Error      string          `json:"error,omitempty"`
}

const maxRows = 10000

func execQuery(lc *liveConn, sqlStr string, limit int, mongoCollection string) queryResult {
	if limit <= 0 || limit > maxRows {
		limit = maxRows
	}

	start := time.Now()

	if lc.driver == "mongo" {
		return execMongoQuery(lc, sqlStr, limit, mongoCollection, start)
	}
	return execSQLQuery(lc, sqlStr, limit, start)
}

func execSQLQuery(lc *liveConn, sqlStr string, limit int, start time.Time) queryResult {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rows, err := lc.db.QueryContext(ctx, sqlStr)
	if err != nil {
		return queryResult{
			Columns: []string{},
			Rows:    [][]interface{}{},
			Error:   err.Error(),
		}
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return queryResult{Error: err.Error()}
	}

	var result [][]interface{}
	scanBuf := make([]interface{}, len(cols))
	rawBuf := make([][]byte, len(cols))
	for i := range rawBuf {
		scanBuf[i] = &rawBuf[i]
	}

	for rows.Next() {
		if len(result) >= limit {
			break
		}
		if err := rows.Scan(scanBuf...); err != nil {
			continue
		}
		row := make([]interface{}, len(cols))
		for i, rb := range rawBuf {
			if rb == nil {
				row[i] = nil
			} else {
				row[i] = string(rb)
			}
		}
		result = append(result, row)
	}

	if result == nil {
		result = [][]interface{}{}
	}

	return queryResult{
		Columns:    cols,
		Rows:       result,
		RowCount:   len(result),
		DurationMs: time.Since(start).Milliseconds(),
	}
}

func execMongoQuery(lc *liveConn, filterJSON string, limit int, collName string, start time.Time) queryResult {
	if collName == "" {
		return queryResult{Error: "select a collection from the schema tree first"}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var filter bson.D
	if strings.TrimSpace(filterJSON) == "" || strings.TrimSpace(filterJSON) == "{}" {
		filter = bson.D{}
	} else {
		if err := bson.UnmarshalExtJSON([]byte(filterJSON), true, &filter); err != nil {
			return queryResult{Error: fmt.Sprintf("invalid JSON filter: %s", err.Error())}
		}
	}

	coll := lc.mongoClient.Database(lc.mongoDB).Collection(collName)
	opts := options.Find().SetLimit(int64(limit))
	cursor, err := coll.Find(ctx, filter, opts)
	if err != nil {
		return queryResult{Error: err.Error()}
	}
	defer cursor.Close(ctx)

	// Collect all documents
	var docs []bson.M
	if err := cursor.All(ctx, &docs); err != nil {
		return queryResult{Error: err.Error()}
	}

	if len(docs) == 0 {
		return queryResult{
			Columns:    []string{},
			Rows:       [][]interface{}{},
			RowCount:   0,
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Collect ordered unique keys from first doc for columns
	colOrder := []string{}
	colSet := map[string]bool{}
	for _, doc := range docs {
		for k := range doc {
			if !colSet[k] {
				colSet[k] = true
				colOrder = append(colOrder, k)
			}
		}
	}

	rows := make([][]interface{}, 0, len(docs))
	for _, doc := range docs {
		row := make([]interface{}, len(colOrder))
		for i, col := range colOrder {
			v := doc[col]
			if v == nil {
				row[i] = nil
			} else {
				row[i] = fmt.Sprintf("%v", v)
			}
		}
		rows = append(rows, row)
	}

	return queryResult{
		Columns:    colOrder,
		Rows:       rows,
		RowCount:   len(rows),
		DurationMs: time.Since(start).Milliseconds(),
	}
}

// ── UUID helper ───────────────────────────────────────────────────────────────

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func dbJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ── Register (HTTP routes) ────────────────────────────────────────────────────

func (p *DBPlugin) Register(mux *http.ServeMux, cfg *config.MineoCfg) {
	// Stash config directory so sub-methods can use it.
	// We derive it from the config path, which is in the same dir as the binary.
	// We use the same approach as the rest of the server: resolve exe dir.
	exe, _ := os.Executable()
	dbConfigDir = filepath.Dir(exe)
	// In `go run .` the binary lands in /tmp, fall back to cwd
	if _, err := os.Stat(filepath.Join(dbConfigDir, "config.json")); os.IsNotExist(err) {
		if cwd, err := os.Getwd(); err == nil {
			dbConfigDir = cwd
		}
	}

	// ── GET /api/plugin/db/connections ───────────────────────────────
	mux.HandleFunc("GET /api/plugin/db/connections", func(w http.ResponseWriter, r *http.Request) {
		conns, err := p.loadConnections()
		if err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		dbJSON(w, http.StatusOK, map[string]interface{}{"connections": conns})
	})

	// ── POST /api/plugin/db/connections ──────────────────────────────
	mux.HandleFunc("POST /api/plugin/db/connections", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Connection  StoredConnection `json:"connection"`
			Password    string           `json:"password"`
			SSHPassword string           `json:"sshPassword"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}

		conn := body.Connection
		conn.ID = newUUID()
		conn.CreatedAt = time.Now().UTC()
		conn.UpdatedAt = conn.CreatedAt

		conns, err := p.loadConnections()
		if err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		conns = append(conns, conn)
		if err := p.saveConnections(conns); err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		cfg.Mu.RLock()
		secret := cfg.Secret
		cfg.Mu.RUnlock()

		key := deriveKey(secret)
		secrets, _ := p.loadSecrets(key)
		if body.Password != "" {
			secrets[conn.ID] = body.Password
		}
		if body.SSHPassword != "" {
			secrets[conn.ID+":sshpass"] = body.SSHPassword
		}
		_ = p.saveSecrets(secrets, key)

		dbJSON(w, http.StatusCreated, map[string]interface{}{"connection": conn})
	})

	// ── PUT /api/plugin/db/connections/{id} ──────────────────────────
	mux.HandleFunc("PUT /api/plugin/db/connections/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var body struct {
			Connection  StoredConnection `json:"connection"`
			Password    string           `json:"password"`
			SSHPassword string           `json:"sshPassword"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}

		conns, err := p.loadConnections()
		if err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		found := false
		for i, c := range conns {
			if c.ID == id {
				body.Connection.ID = id
				body.Connection.CreatedAt = c.CreatedAt
				body.Connection.UpdatedAt = time.Now().UTC()
				conns[i] = body.Connection
				found = true
				break
			}
		}
		if !found {
			dbJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		if err := p.saveConnections(conns); err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		cfg.Mu.RLock()
		secret := cfg.Secret
		cfg.Mu.RUnlock()

		key := deriveKey(secret)
		secrets, _ := p.loadSecrets(key)
		if body.Password != "" {
			secrets[id] = body.Password
		}
		if body.SSHPassword != "" {
			secrets[id+":sshpass"] = body.SSHPassword
		}
		_ = p.saveSecrets(secrets, key)

		dbJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})

	// ── DELETE /api/plugin/db/connections/{id} ────────────────────────
	mux.HandleFunc("DELETE /api/plugin/db/connections/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")

		// Disconnect if live
		p.mu.Lock()
		if lc, ok := p.conns[id]; ok {
			closeLiveConn(lc)
			delete(p.conns, id)
		}
		p.mu.Unlock()

		conns, err := p.loadConnections()
		if err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		updated := conns[:0]
		for _, c := range conns {
			if c.ID != id {
				updated = append(updated, c)
			}
		}
		if err := p.saveConnections(updated); err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		cfg.Mu.RLock()
		secret := cfg.Secret
		cfg.Mu.RUnlock()

		key := deriveKey(secret)
		secrets, _ := p.loadSecrets(key)
		delete(secrets, id)
		delete(secrets, id+":sshpass")
		_ = p.saveSecrets(secrets, key)

		dbJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})

	// ── POST /api/plugin/db/connect ───────────────────────────────────
	mux.HandleFunc("POST /api/plugin/db/connect", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "missing id"})
			return
		}

		// Already connected?
		p.mu.RLock()
		_, already := p.conns[body.ID]
		p.mu.RUnlock()
		if already {
			dbJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
			return
		}

		conns, err := p.loadConnections()
		if err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		var conn *StoredConnection
		for i := range conns {
			if conns[i].ID == body.ID {
				conn = &conns[i]
				break
			}
		}
		if conn == nil {
			dbJSON(w, http.StatusNotFound, map[string]string{"error": "connection not found"})
			return
		}

		cfg.Mu.RLock()
		secret := cfg.Secret
		cfg.Mu.RUnlock()

		key := deriveKey(secret)
		secrets, _ := p.loadSecrets(key)
		password := secrets[body.ID]
		sshPass := secrets[body.ID+":sshpass"]

		lc, err := p.openConnection(cfg, conn, password, sshPass)
		if err != nil {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		p.mu.Lock()
		p.conns[body.ID] = lc
		p.mu.Unlock()

		dbJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})

	// ── POST /api/plugin/db/disconnect ───────────────────────────────
	mux.HandleFunc("POST /api/plugin/db/disconnect", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "missing id"})
			return
		}

		p.mu.Lock()
		lc, ok := p.conns[body.ID]
		if ok {
			closeLiveConn(lc)
			delete(p.conns, body.ID)
		}
		p.mu.Unlock()

		dbJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})

	// ── GET /api/plugin/db/status ─────────────────────────────────────
	mux.HandleFunc("GET /api/plugin/db/status", func(w http.ResponseWriter, r *http.Request) {
		p.mu.RLock()
		status := make(map[string]bool, len(p.conns))
		for id := range p.conns {
			status[id] = true
		}
		p.mu.RUnlock()
		dbJSON(w, http.StatusOK, status)
	})

	// ── GET /api/plugin/db/schema?conn= ──────────────────────────────
	mux.HandleFunc("GET /api/plugin/db/schema", func(w http.ResponseWriter, r *http.Request) {
		connID := r.URL.Query().Get("conn")
		if connID == "" {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "conn required"})
			return
		}

		p.mu.RLock()
		lc, ok := p.conns[connID]
		p.mu.RUnlock()
		if !ok {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "not connected"})
			return
		}

		schema, err := fetchSchema(lc)
		if err != nil {
			dbJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		dbJSON(w, http.StatusOK, map[string]interface{}{"schema": schema})
	})

	// ── POST /api/plugin/db/query ─────────────────────────────────────
	mux.HandleFunc("POST /api/plugin/db/query", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Conn       string `json:"conn"`
			SQL        string `json:"sql"`
			Limit      int    `json:"limit"`
			Collection string `json:"collection"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if body.Conn == "" {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "conn required"})
			return
		}

		p.mu.RLock()
		lc, ok := p.conns[body.Conn]
		p.mu.RUnlock()
		if !ok {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "not connected"})
			return
		}

		result := execQuery(lc, body.SQL, body.Limit, body.Collection)
		dbJSON(w, http.StatusOK, result)
	})

	// ── POST /api/plugin/db/test ──────────────────────────────────────
	mux.HandleFunc("POST /api/plugin/db/test", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Connection  StoredConnection `json:"connection"`
			Password    string           `json:"password"`
			SSHPassword string           `json:"sshPassword"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			dbJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}

		body.Connection.ID = "__test__"
		lc, err := p.openConnection(cfg, &body.Connection, body.Password, body.SSHPassword)
		if err != nil {
			dbJSON(w, http.StatusOK, map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		closeLiveConn(lc)
		dbJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
	})
}
