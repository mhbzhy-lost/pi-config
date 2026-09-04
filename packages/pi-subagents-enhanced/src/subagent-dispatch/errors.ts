export class CodingDispatchContractError extends Error {
  constructor(code, message, detail = message, keypath) {
    super(message);
    this.name = "CodingDispatchContractError";
    this.code = code;
    this.detail = String(detail);
    if (keypath !== undefined) this.keypath = String(keypath);
  }
}
