import crc from "crc"
import { Principal } from "@icp-sdk/core/principal"
import { sha224 } from "js-sha256"

export const calculateCrc32 = (bytes: Uint8Array): Uint8Array => {
  const checksumArrayBuf = new ArrayBuffer(4)
  const view = new DataView(checksumArrayBuf)
  view.setUint32(0, crc.crc32(Buffer.from(bytes)), false)
  return Buffer.from(checksumArrayBuf)
}

export const asciiStringToByteArray = (text: string): Array<number> => {
  return Array.from(text).map(c => c.charCodeAt(0))
}

export function toHexString(bytes: ArrayBuffer): string {
  return new Uint8Array(bytes).reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "")
}

export const principalToAccountId = (principal: Principal | string, subAccount?: Uint8Array): string => {
  // Hash (sha224) the principal, the subAccount and some padding
  const principalToUse = principal instanceof Principal ? principal : Principal.fromText(principal);
  const padding = asciiStringToByteArray("\x0Aaccount-id");

  const shaObj = sha224.create();
  shaObj.update([...padding, ...principalToUse.toUint8Array(), ...(subAccount ?? Array(32).fill(0))])
  const hash = new Uint8Array(shaObj.array())

  // Prepend the checksum of the hash and convert to a hex string
  const checksum = calculateCrc32(hash)
  const bytes = new Uint8Array([...checksum, ...hash])
  return toHexString(bytes.buffer)
}
