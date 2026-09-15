export * from "./entities.js";
export * from "./protocol.js";
export * from "./version.js";
export * as schemas from "./schemas.js";
// Re-exported so services can CLASSIFY a validation failure without taking a
// direct zod dependency of their own — core already owns that relationship, and
// two copies of zod in the tree would break `instanceof` silently (#265).
export { ZodError } from "zod";
