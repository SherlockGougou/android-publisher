import crypto from 'crypto';
import fs from 'fs';

/**
 * HmacSHA256 签名，返回小写十六进制字符串
 * @param {string} key
 * @param {string} data
 * @returns {string}
 */
export function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest('hex');
}

/**
 * 计算文件 MD5，返回小写十六进制字符串
 * @param {string} filePath 文件绝对路径
 * @returns {string}
 */
export function md5File(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * 计算文件 SHA-256，返回小写十六进制字符串
 * @param {string} filePath 文件绝对路径
 * @returns {string}
 */
export function sha256File(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 小米 X.509 证书公钥加密（RSA/PKCS1，分块加密，结果转 Hex）
 *
 * 小米使用 1024-bit RSA，块大小 117 字节（128 - 11），
 * 加密结果为各块拼接后的 hex 字符串。
 *
 * @param {string} x509CertPem  X.509 证书内容（-----BEGIN CERTIFICATE----- ... ）
 * @param {string} plainText    待加密的字符串
 * @returns {string}  hex 字符串
 */
export function miRsaEncrypt(x509CertPem, plainText) {
  // 使用 node-forge 解析 X.509 证书并提取公钥
  // Node.js 内置 crypto 不直接支持 X.509 DER 公钥提取；
  // 通过 crypto.X509Certificate 提取 publicKey（Node 16+）
  const cert = new crypto.X509Certificate(x509CertPem);
  const publicKey = cert.publicKey;

  const data = Buffer.from(plainText, 'utf-8');
  const GROUP_SIZE = 128; // 1024-bit RSA
  const ENCRYPT_GROUP_SIZE = GROUP_SIZE - 11; // PKCS1 padding overhead
  const chunks = [];

  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + ENCRYPT_GROUP_SIZE);
    const encrypted = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      chunk
    );
    chunks.push(encrypted);
    offset += ENCRYPT_GROUP_SIZE;
  }

  return Buffer.concat(chunks).toString('hex');
}
