// Railway Function loader puts express on globalThis; the bundle must not import it.
export default globalThis.__express;
