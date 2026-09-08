import dropboxLogo from '../assets/dropbox.svg';
import googleDriveLogo from '../assets/google-drive.svg';
import megaLogo from '../assets/mega.svg';
import oneDriveLogo from '../assets/microsoft-onedrive.svg';
import s3Logo from '../assets/s3-storage.svg';
import yandexLogo from '../assets/yandex-disk.svg';

const PROVIDER_META = {
	google_drive: { key: 'google_drive', label: 'Google Drive', icon: googleDriveLogo },
	onedrive: { key: 'onedrive', label: 'OneDrive', icon: oneDriveLogo },
	dropbox: { key: 'dropbox', label: 'Dropbox', icon: dropboxLogo },
	mega: { key: 'mega', label: 'MEGA', icon: megaLogo },
	yandex: { key: 'yandex', label: 'Yandex Disk', icon: yandexLogo },
	s3: { key: 's3', label: 'S3 Storage', icon: s3Logo },
};

function toNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function getProviderMeta(provider) {
	return PROVIDER_META[provider] || { key: provider || 'unknown', label: provider || 'Provider', icon: null };
}

export function providerKey(file) {
	return `${file.provider || 'unknown'}::${file.email || ''}`;
}

export function providerLabel(provider) {
	return getProviderMeta(provider).label;
}

export function providerIcon(provider) {
	return getProviderMeta(provider).icon;
}

export function formatBytes(value) {
	if (!value) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let amount = toNumber(value);
	let index = 0;
	while (amount >= 1024 && index < units.length - 1) {
		amount /= 1024;
		index += 1;
	}
	return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatBytesStrict(value) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let amount = toNumber(value);
	let index = 0;
	while (amount >= 1024 && index < units.length - 1) {
		amount /= 1024;
		index += 1;
	}
	return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDate(value, locale = 'es-ES') {
	if (!value) return '—';
	return new Intl.DateTimeFormat(locale, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	}).format(new Date(value));
}

export function getCreatedTime(file) {
	return file.createdTime;
}

export function getModifiedTime(file) {
	return file.modifiedTime;
}
