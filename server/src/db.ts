// Backward-compat re-export — all code that does `import db from './db'` keeps working.
// The real implementation is in db/index.ts.
export { db as default, db } from './db/index'
