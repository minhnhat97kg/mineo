/**
 * This file can be edited to customize webpack configuration.
 * To reset delete this file and rerun theia build again.
 */
// @ts-check
const configs = require('./gen-webpack.config.js');
const nodeConfig = require('./gen-webpack.node.config.js');
const CopyPlugin = require('copy-webpack-plugin');
const path = require('path');

/**
 * Expose bundled modules on window.theia.moduleName namespace, e.g.
 * window['theia']['@theia/core/lib/common/uri'].
 * Such syntax can be used by external code, for instance, for testing.
configs[0].module.rules.push({
    test: /\.js$/,
    loader: require.resolve('@theia/application-manager/lib/expose-loader')
}); */

// Copy index.html to the output directory so express.static(lib/frontend)
// can serve it for GET /
configs[0].plugins = (configs[0].plugins || []).concat([
    new CopyPlugin({
        patterns: [
            {
                // index.html is not emitted by webpack — copy it explicitly so
                // express.static(lib/frontend) can serve it for GET /
                from: path.resolve(__dirname, 'src-gen/frontend/index.html'),
            },
        ],
    }),
]);

module.exports = [
    ...configs,
    nodeConfig.config
];
