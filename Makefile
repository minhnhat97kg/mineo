.PHONY: build client-build go-build install start dev clean

# Build everything: client + Go binary
build: client-build go-build

# Install client dependencies
install:
	cd client && npm install

# Build the React client
client-build:
	cd client && npm run build

# Copy client dist into server for embedding, then build Go binary
go-build:
	rm -rf server/client_dist
	cp -r client/dist server/client_dist
	cd server && go build -o ../mineo .

# Start the Go server
start: build
	./mineo

# Dev: run Go server from source
dev:
	rm -rf server/client_dist
	cp -r client/dist server/client_dist
	cd server && MINEO_CONFIG="$$(cd .. && pwd)/config.json" go run .

# Clean build artifacts
clean:
	rm -rf server/client_dist mineo client/dist
