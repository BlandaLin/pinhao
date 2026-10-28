function keyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createSecrets(storage) {
  async function decrypt(encoded) {
    try {
      const bytes = Buffer.from(encoded, 'base64');
      const result = storage.decryptStringAsync
        ? (await storage.decryptStringAsync(bytes)).result
        : storage.decryptString(bytes);
      if (typeof result !== 'string') throw new Error('Invalid decryption result');
      return result;
    } catch {
      throw keyError('API_KEY_UNREADABLE', '请在“设置”中重新粘贴 API 密钥并保存，以恢复模型连接。项目与译文已保留。');
    }
  }

  return {
    decrypt,
    async encrypt(text) {
      try {
        if (!storage.encryptStringAsync && !storage.isEncryptionAvailable()) throw new Error('Storage unavailable');
        const encrypted = storage.encryptStringAsync
          ? await storage.encryptStringAsync(text)
          : storage.encryptString(text);
        const encoded = encrypted.toString('base64');
        if (await decrypt(encoded) !== text) throw new Error('Encryption roundtrip mismatch');
        return encoded;
      } catch {
        throw keyError('API_KEY_SAVE_FAILED', 'API 密钥保存校验失败，请重启工作台后重新粘贴并保存。原有配置已保留。');
      }
    },
  };
}
