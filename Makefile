.PHONY: build build-all start clean

# Fast build: Compile TS and bundle with Webpack
# Use this for UI/Logic changes in src/
build:
	cd app && npx tsc && npx webpack --config webpack.config.js --mode development

# Full build: Regenerate Theia src-gen and bundle everything
# Use this for dependency/config changes or first-time setup
build-all:
	cd app && npm run build

# Start the application
start:
	npm start

# Clean build artifacts
clean:
	cd app && rm -rf lib src-gen dist
