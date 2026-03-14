/**
 * Patch: @theia/plugin-ext lib/common/rpc-protocol.js
 * 
 * Fix: handleRequest and handleNotification throw immediately when a service
 * handler isn't registered yet. This causes the plugin-host to crash at startup
 * when it tries to use LoggerMain before the browser frontend has called
 * setUpPluginApi(). The fix makes both methods wait up to 10s for the handler.
 */
module.exports = {
  target: 'node_modules/@theia/plugin-ext/lib/common/rpc-protocol.js',

  // String that must exist for the patch to apply (proves file is unpatched)
  guard: '        if (!handler) {\n            throw new Error(`no local service handler with id ${serviceId}`);\n        }\n        handler[method](...(args.slice(1)));\n    }\n    handleRequest',

  // String to find and replace
  find: `    handleNotification(method, args) {
        const serviceId = args[0];
        const handler = this.locals.get(serviceId);
        if (!handler) {
            throw new Error(\`no local service handler with id \${serviceId}\`);
        }
        handler[method](...(args.slice(1)));
    }
    handleRequest(method, args) {
        const serviceId = args[0];
        const handler = this.locals.get(serviceId);
        if (!handler) {
            throw new Error(\`no local service handler with id \${serviceId}\`);
        }
        return handler[method](...(args.slice(1)));
    }`,

  replace: `    waitForHandler(serviceId, timeoutMs = 10000) {
        const handler = this.locals.get(serviceId);
        if (handler) {
            return Promise.resolve(handler);
        }
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const poll = () => {
                if (this.isDisposed) {
                    return reject(ConnectionClosedError.create());
                }
                const h = this.locals.get(serviceId);
                if (h) {
                    return resolve(h);
                }
                if (Date.now() >= deadline) {
                    return reject(new Error(\`no local service handler with id \${serviceId}\`));
                }
                setTimeout(poll, 50);
            };
            poll();
        });
    }
    handleNotification(method, args) {
        const serviceId = args[0];
        const handler = this.locals.get(serviceId);
        if (handler) {
            handler[method](...(args.slice(1)));
            return;
        }
        // Handler not yet registered — wait for it (startup race condition)
        this.waitForHandler(serviceId).then(h => h[method](...(args.slice(1)))).catch(err => {
            console.error(\`handleNotification: \${err.message}\`);
        });
    }
    handleRequest(method, args) {
        const serviceId = args[0];
        const handler = this.locals.get(serviceId);
        if (handler) {
            return handler[method](...(args.slice(1)));
        }
        // Handler not yet registered — wait for it (startup race condition)
        return this.waitForHandler(serviceId).then(h => h[method](...(args.slice(1))));
    }`,
};
