// esbuild inlines `.pem` files as text (build.mjs `loader`).
declare module '*.pem' {
  const text: string;
  export default text;
}
