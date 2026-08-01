const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,/i;
const HISTORY_ASSET_PATTERN = /^\/api\/history-assets\/[^/]+$/;

export function resolveTrustedImageSource(value, appOrigin) {
  const source = String(value || "");
  if (DATA_IMAGE_PATTERN.test(source)) return source;

  let url;
  try {
    url = new URL(source, appOrigin);
  } catch {
    throw new Error("图片来源无效，无法复制或导入。");
  }
  if (
    url.origin !== appOrigin ||
    !HISTORY_ASSET_PATTERN.test(url.pathname) ||
    url.username ||
    url.password
  ) {
    throw new Error("仅支持复制或导入已验证的本地历史图片。");
  }
  return url.toString();
}
