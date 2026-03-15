const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devtool: 'source-map',
    entry: './src/main.tsx',
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist'),
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader'],
                sideEffects: true,
            },
            {
                test: /\.(woff|woff2|ttf|eot)$/,
                type: 'asset/resource',
                generator: { filename: '[name][ext]' },
            },
        ],
    },
    plugins: [
        new MiniCssExtractPlugin({ filename: 'bundle.css' }),
    ],
};
