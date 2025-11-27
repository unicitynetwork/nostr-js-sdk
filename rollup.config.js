import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

const external = ['zlib', 'ws'];

const basePlugins = [
  resolve({
    browser: true,
    preferBuiltins: false,
  }),
  commonjs(),
  typescript({
    tsconfig: './tsconfig.json',
    declaration: false,
    declarationMap: false,
  }),
];

// ESM bundle
const esmConfig = {
  input: 'src/index.ts',
  output: {
    file: 'dist/browser/index.js',
    format: 'esm',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  external,
  plugins: basePlugins,
};

// ESM minified bundle
const esmMinConfig = {
  input: 'src/index.ts',
  output: {
    file: 'dist/browser/index.min.js',
    format: 'esm',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  external,
  plugins: [...basePlugins, terser()],
};

// UMD bundle
const umdConfig = {
  input: 'src/index.ts',
  output: {
    file: 'dist/browser/index.umd.js',
    format: 'umd',
    name: 'UnicityNostr',
    sourcemap: true,
    inlineDynamicImports: true,
    globals: {
      zlib: 'zlib',
    },
  },
  external,
  plugins: basePlugins,
};

// UMD minified bundle
const umdMinConfig = {
  input: 'src/index.ts',
  output: {
    file: 'dist/browser/index.umd.min.js',
    format: 'umd',
    name: 'UnicityNostr',
    sourcemap: true,
    inlineDynamicImports: true,
    globals: {
      zlib: 'zlib',
    },
  },
  external,
  plugins: [...basePlugins, terser()],
};

export default [esmConfig, esmMinConfig, umdConfig, umdMinConfig];
