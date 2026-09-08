const BASE = Object.freeze({
  upload: true,
  download: true,
  move: false,
  rename: true,
  delete: true,
  folders: true,
  streaming: true,
  serverSideCopy: false,
  checksum: false,
});

export const PROVIDER_CAPABILITIES = Object.freeze({
  google_drive: Object.freeze({ ...BASE, move: true, serverSideCopy: true }),
  onedrive: Object.freeze({ ...BASE, move: true }),
  dropbox: Object.freeze({ ...BASE, move: true, serverSideCopy: true }),
  yandex: Object.freeze({ ...BASE, move: true }),
  s3: Object.freeze({ ...BASE, move: true, serverSideCopy: true }),
  mega: Object.freeze({ ...BASE }),
});

export function getProviderCapabilities(provider) {
  return PROVIDER_CAPABILITIES[provider] || BASE;
}
