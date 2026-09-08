export const DUPLICATE_POLICIES = new Set(['rename', 'overwrite', 'reject']);

export const DEFAULT_DUPLICATE_POLICY = 'rename';

export const DANGEROUS_EXTENSIONS = new Set([
  'ade', 'adp', 'apk', 'appx', 'appxbundle', 'asp', 'aspx', 'bat', 'cab', 'cmd', 'com', 'cpl',
  'crt', 'dll', 'dmg', 'exe', 'hta', 'inf', 'ins', 'iso', 'jar', 'js', 'jse', 'lnk', 'mde',
  'msc', 'msi', 'msp', 'mst', 'ocx', 'ps1', 'ps2', 'psm1', 'reg', 'scr', 'sys', 'vbe', 'vbs',
  'vhd', 'vhdx', 'vxd', 'wsc', 'wsf', 'wsh', 'xll',
]);

export const EXTENSION_MIME_TYPES = {
  '3g2': 'video/3gpp2', '3gp': 'video/3gpp', '7z': 'application/x-7z-compressed', aac: 'audio/aac', ai: 'application/postscript',
  aiff: 'audio/aiff', avif: 'image/avif', avi: 'video/x-msvideo', bmp: 'image/bmp', csv: 'text/csv', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', eot: 'application/vnd.ms-fontobject', epub: 'application/epub+zip',
  flac: 'audio/flac', gif: 'image/gif', gz: 'application/gzip', heic: 'image/heic', heif: 'image/heif', html: 'text/html',
  ico: 'image/x-icon', jpeg: 'image/jpeg', jpg: 'image/jpeg', json: 'application/json', m4a: 'audio/mp4', m4v: 'video/mp4',
  md: 'text/markdown', mkv: 'video/x-matroska', mov: 'video/quicktime', mp3: 'audio/mpeg', mp4: 'video/mp4', mpeg: 'video/mpeg',
  mpg: 'video/mpeg', odp: 'application/vnd.oasis.opendocument.presentation', ods: 'application/vnd.oasis.opendocument.spreadsheet', odt: 'application/vnd.oasis.opendocument.text',
  ogg: 'audio/ogg', otf: 'font/otf', pdf: 'application/pdf', png: 'image/png', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', rar: 'application/vnd.rar', rtf: 'application/rtf',
  svg: 'image/svg+xml', tar: 'application/x-tar', tif: 'image/tiff', tiff: 'image/tiff', ts: 'video/mp2t', txt: 'text/plain',
  wav: 'audio/wav', webm: 'video/webm', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', zip: 'application/zip',
};

const MIME_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['audio/x-wav', 'audio/wav'],
  ['text/x-markdown', 'text/markdown'],
  ['application/x-gzip', 'application/gzip'],
  ['application/x-rar-compressed', 'application/vnd.rar'],
]);

export function normalizeDuplicatePolicy(value, fallback = DEFAULT_DUPLICATE_POLICY) {
  const normalized = String(value || '').trim().toLowerCase();
  return DUPLICATE_POLICIES.has(normalized) ? normalized : fallback;
}

export function fileExtension(fileName = '') {
  const clean = String(fileName).split(/[\\/]/).pop() || '';
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

export function validateFileType(fileName, mimeType) {
  const extension = fileExtension(fileName);
  const mime = String(mimeType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  const canonicalMime = MIME_ALIASES.get(mime) || mime;

  if (extension && DANGEROUS_EXTENSIONS.has(extension)) {
    const error = new Error('This file extension is not allowed for uploads');
    error.status = 415;
    error.code = 'FILE_TYPE_NOT_ALLOWED';
    throw error;
  }

  const expectedMime = EXTENSION_MIME_TYPES[extension];
  if (canonicalMime !== 'application/octet-stream' && expectedMime && canonicalMime !== expectedMime) {
    const error = new Error(`File extension .${extension} does not match Content-Type ${canonicalMime}`);
    error.status = 415;
    error.code = 'MIME_EXTENSION_MISMATCH';
    throw error;
  }

  return { extension, mimeType: expectedMime || canonicalMime };
}

export async function resolveDuplicateName({ policy, fileName, listExisting, exists }) {
  const normalizedPolicy = normalizeDuplicatePolicy(policy);
  if (!await exists(fileName)) return fileName;
  if (normalizedPolicy === 'overwrite') return fileName;
  if (normalizedPolicy === 'reject') {
    const error = new Error(`An item named "${fileName}" already exists`);
    error.status = 409;
    error.code = 'DUPLICATE_FILE';
    throw error;
  }

  const existing = await listExisting();
  const names = new Set(existing.map((item) => String(item || '').toLowerCase()));
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  let index = 1;
  let candidate = `${stem} (${index})${extension}`;
  while (names.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${stem} (${index})${extension}`;
  }
  return candidate;
}
