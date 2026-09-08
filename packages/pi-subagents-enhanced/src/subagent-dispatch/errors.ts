declare global {
  interface Error {
    code?: string;
    detail?: unknown;
    keypath?: string;
  }
}

export class CodingDispatchContractError extends Error {
  code: string;
  detail: string;
  keypath?: string;
  constructor(code, message, detail = message, keypath?: string) {
    super(message);
    this.name = "CodingDispatchContractError";
    this.code = code;
    this.detail = String(detail);
    if (keypath !== undefined) this.keypath = String(keypath);
  }
}
