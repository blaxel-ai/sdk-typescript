const path = require('path');

module.exports = {
  mode: 'development',
  entry: './src/index.ts',
  target: 'node',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // Support for package.json exports field
    conditionNames: ['import', 'require', 'node', 'default']
  },
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
  externals: {
    // Don't bundle these - they should be available in the runtime
  }
};
