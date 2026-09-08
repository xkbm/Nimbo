<script setup>
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
	IconChevronDown,
	IconCloud,
	IconLinkPlus,
	IconPlugConnected,
	IconPlugConnectedX,
	IconRefresh,
	IconArrowUp,
	IconArrowDown,
	IconGripVertical,
	IconDeviceFloppy,
	IconCheck,
	IconChartPie,
	IconAdjustments,
} from '@tabler/icons-vue';
import DriveShell from '../components/DriveShell.vue';
import MegaConnectModal from '../components/MegaConnectModal.vue';
import S3ConnectModal from '../components/S3ConnectModal.vue';
import TruncateMarquee from '../components/TruncateMarquee.vue';
import { useAccountManagementStore } from '../stores/accountManagement';
import { api } from '../services/api';
import { formatBytesStrict, providerIcon, providerLabel } from '../composables/useFormatFile.js';
import { useStorageStats } from '../composables/useStorageStats.js';

const { t } = useI18n();
const accountStore = useAccountManagementStore();
const { accounts, isLoading, error, isDisconnectingId } = storeToRefs(accountStore);
const route = useRoute();
const router = useRouter();
const { poolStats, totalUsed, totalSpace, totalFree, usedFormatted, totalFormatted, freeFormatted, usedTotalLabel } = useStorageStats();

const connectingProvider = ref('');
const actionError = ref('');
const actionSuccess = ref('');
const isSyncing = ref(false);
const isConnectMenuOpen = ref(false);
const isMegaModalOpen = ref(false);
const isS3ModalOpen = ref(false);

const ALLOCATION_STRATEGIES = ['round_robin', 'weighted_round_robin', 'least_used', 'most_free', 'manual'];
const activeTab = ref('overview');
const selectedStrategy = ref('round_robin');
const allocationOrder = ref([]);
const isAllocationLoading = ref(false);
const isSavingAllocation = ref(false);
const allocationError = ref('');
const allocationSaved = ref(false);
const dragIndex = ref(null);

const allocationStrategyOptions = computed(() =>
	ALLOCATION_STRATEGIES.map((key) => ({
		key,
		label: t(`allocation.strategies.${key}`),
		description: t(`allocation.strategies.${key}_desc`),
	})),
);

const orderedAllocationAccounts = computed(() => {
	const byId = new Map(accounts.value.map((account) => [account.id, account]));
	const ordered = [];
	allocationOrder.value.forEach((id) => {
		if (byId.has(id)) {
			ordered.push(byId.get(id));
			byId.delete(id);
		}
	});
	[...byId.values()].forEach((account) => ordered.push(account));
	return ordered;
});

const accountPalette = [
	{
		used: 'bg-[#1a73e8]',
		free: 'bg-[#d2e3fc]',
		surface: 'bg-[#e8f0fe]',
		text: 'text-[#1a73e8]',
	},
	{
		used: 'bg-[#188038]',
		free: 'bg-[#ceead6]',
		surface: 'bg-[#e6f4ea]',
		text: 'text-[#188038]',
	},
	{
		used: 'bg-[#c26401]',
		free: 'bg-[#fce8b2]',
		surface: 'bg-[#fef7e0]',
		text: 'text-[#c26401]',
	},
	{
		used: 'bg-[#9334e6]',
		free: 'bg-[#e9d7fe]',
		surface: 'bg-[#f3e8ff]',
		text: 'text-[#9334e6]',
	},
];

const providerConnectOptions = computed(() => [
	{
		key: 'google_drive',
		label: t('providers.googleDrive'),
		busyLabel: t('storage.connectingProvider', { provider: 'Google' }),
		icon: providerIcon('google_drive'),
		action: connectGoogleDrive,
	},
	{
		key: 'onedrive',
		label: t('providers.oneDrive'),
		busyLabel: t('storage.connectingProvider', { provider: 'OneDrive' }),
		icon: providerIcon('onedrive'),
		action: connectOneDrive,
	},
	{
		key: 'dropbox',
		label: t('providers.dropbox'),
		busyLabel: t('storage.connectingProvider', { provider: 'Dropbox' }),
		icon: providerIcon('dropbox'),
		action: connectDropbox,
	},
	{
		key: 'mega',
		label: t('providers.mega'),
		busyLabel: t('storage.connectingProvider', { provider: 'MEGA' }),
		icon: providerIcon('mega'),
		action: openMegaModal,
	},
	{
		key: 'yandex',
		label: t('providers.yandex'),
		busyLabel: t('storage.connectingProvider', { provider: 'Yandex' }),
		icon: providerIcon('yandex'),
		action: connectYandex,
	},
	{
		key: 's3',
		label: t('providers.s3'),
		busyLabel: t('storage.connectingProvider', { provider: 'S3' }),
		icon: providerIcon('s3'),
		action: openS3Modal,
	},
]);

const storageSegments = computed(() => {
	const total = totalSpace.value || 1;
	const physicalAccounts = poolStats.value?.backends || accounts.value;

	const accountSegments = physicalAccounts.flatMap((account, index) => {
		if (account.status && account.status !== 'active') return [];
		const used = Math.max(0, Number(account.used_space || 0));
		const capacity = Math.max(0, Number(account.total_space || 0));
		const free = Math.max(0, capacity - used);
		const palette = accountPalette[index % accountPalette.length];

		return [
			{
				key: `${account.id}-used`,
				width: `${(used / total) * 100}%`,
				className: palette.used,
			},
			{
				key: `${account.id}-free`,
				width: `${(free / total) * 100}%`,
				className: palette.free,
			},
		].filter((segment) => Number.parseFloat(segment.width) > 0);
	});

	if (!accountSegments.length && totalFree.value > 0) {
		return [
			{
				key: 'empty-free',
				width: '100%',
				className: 'bg-[#eef2f7] dark:bg-slate-700',
			},
		];
	}

	return accountSegments;
});

const accountLegends = computed(() => {
	const physicalAccounts = poolStats.value?.backends || accounts.value;
	return physicalAccounts.map((account, index) => {
		const used = Math.max(0, Number(account.used_space || 0));
		const total = Math.max(0, Number(account.total_space || 0));
		const free = Math.max(0, total - used);
		return {
			...account,
			used,
			free,
			palette: accountPalette[index % accountPalette.length],
		};
	});
});

function providerBadgeClass(status) {
	return status === 'active'
		? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
		: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
}

function isReconnectable(account) {
	return ['suspended', 'invalid_token'].includes(account?.status);
}

function isAccountActionBusy(account) {
	if (isReconnectable(account)) {
		return connectingProvider.value === account.provider;
	}

	return isDisconnectingId.value === account.id;
}

function accountActionLabel(account) {
	if (isReconnectable(account)) {
		return connectingProvider.value === account.provider ? t('storage.connecting') : t('storage.connect');
	}

	return isDisconnectingId.value === account.id ? t('storage.disconnecting') : t('storage.disconnect');
}

async function reconnectAccount(account) {
	if (account.provider === 'google_drive') {
		await connectGoogleDrive();
		return;
	}

	if (account.provider === 'onedrive') {
		await connectOneDrive();
		return;
	}

	if (account.provider === 'dropbox') {
		await connectDropbox();
		return;
	}

	if (account.provider === 'mega') {
		openMegaModal();
		return;
	}

	actionError.value = t('storage.reconnectNotSupported', { provider: providerLabel(account.provider) });
}

async function handleAccountAction(account) {
	if (isReconnectable(account)) {
		await reconnectAccount(account);
		return;
	}

	await disconnectAccount(account);
}

async function loadPage() {
	await accountStore.loadAccounts();
	await loadAllocation();
}

async function loadAllocation() {
	isAllocationLoading.value = true;
	allocationError.value = '';
	try {
		const { data } = await api.getAllocation();
		if (data?.strategy && ALLOCATION_STRATEGIES.includes(data.strategy)) {
			selectedStrategy.value = data.strategy;
		}
		allocationOrder.value = Array.isArray(data?.accounts)
			? data.accounts.map((account) => account.id)
			: [];
	} catch (error) {
		allocationError.value = error.message;
	} finally {
		isAllocationLoading.value = false;
	}
}

function selectStrategy(key) {
	if (!ALLOCATION_STRATEGIES.includes(key)) return;
	selectedStrategy.value = key;
	allocationSaved.value = false;
}

function syncOrderFromAccounts() {
	allocationOrder.value = orderedAllocationAccounts.value.map((account) => account.id);
}

function moveAccount(index, direction) {
	syncOrderFromAccounts();
	const target = index + direction;
	if (target < 0 || target >= allocationOrder.value.length) return;
	const next = [...allocationOrder.value];
	[next[index], next[target]] = [next[target], next[index]];
	allocationOrder.value = next;
	allocationSaved.value = false;
}

function onDragStart(index) {
	syncOrderFromAccounts();
	dragIndex.value = index;
}

function onDragOver(index, event) {
	event.preventDefault();
	if (dragIndex.value === null || dragIndex.value === index) return;
	const next = [...allocationOrder.value];
	const [moved] = next.splice(dragIndex.value, 1);
	next.splice(index, 0, moved);
	allocationOrder.value = next;
	dragIndex.value = index;
	allocationSaved.value = false;
}

function onDragEnd() {
	dragIndex.value = null;
}

async function saveAllocation() {
	isSavingAllocation.value = true;
	allocationError.value = '';
	allocationSaved.value = false;
	syncOrderFromAccounts();
	try {
		const { data } = await api.updateAllocation({
			strategy: selectedStrategy.value,
			order: allocationOrder.value,
		});
		if (data?.strategy) selectedStrategy.value = data.strategy;
		allocationOrder.value = Array.isArray(data?.accounts)
			? data.accounts.map((account) => account.id)
			: allocationOrder.value;
		allocationSaved.value = true;
	} catch (error) {
		allocationError.value = error.message;
	} finally {
		isSavingAllocation.value = false;
	}
}

async function connectGoogleDrive() {
	connectingProvider.value = 'google_drive';
	isConnectMenuOpen.value = false;
	actionError.value = '';
	try {
		const { data } = await api.getGoogleConnectUrl();
		window.location.href = data.authorizationUrl;
	} catch (error) {
		actionError.value = error.message;
	} finally {
		connectingProvider.value = '';
	}
}

async function connectOneDrive() {
	connectingProvider.value = 'onedrive';
	isConnectMenuOpen.value = false;
	actionError.value = '';
	try {
		const { data } = await api.getOneDriveConnectUrl();
		window.location.href = data.authorizationUrl;
	} catch (error) {
		actionError.value = error.message;
	} finally {
		connectingProvider.value = '';
	}
}

async function connectDropbox() {
	connectingProvider.value = 'dropbox';
	isConnectMenuOpen.value = false;
	actionError.value = '';
	try {
		const { data } = await api.getDropboxConnectUrl();
		window.location.href = data.authorizationUrl;
	} catch (error) {
		actionError.value = error.message;
	} finally {
		connectingProvider.value = '';
	}
}

function openMegaModal() {
	isConnectMenuOpen.value = false;
	actionError.value = '';
	isMegaModalOpen.value = true;
}

function closeMegaModal() {
	if (connectingProvider.value === 'mega') return;
	isMegaModalOpen.value = false;
}

async function connectMega(payload) {
	connectingProvider.value = 'mega';
	actionError.value = '';
	try {
		await api.connectMegaAccount(payload);
		await accountStore.loadAccounts();
		isMegaModalOpen.value = false;
	} catch (error) {
		actionError.value = error.message;
	} finally {
		connectingProvider.value = '';
	}
}

async function connectYandex() {
	connectingProvider.value = 'yandex';
	isConnectMenuOpen.value = false;
	actionError.value = '';
	try {
		const { data } = await api.getYandexConnectUrl();
		window.location.href = data.authorizationUrl;
	} catch (error) {
		actionError.value = error.message;
		connectingProvider.value = '';
	}
}

function openS3Modal() {
	isConnectMenuOpen.value = false;
	actionError.value = '';
	isS3ModalOpen.value = true;
}

function closeS3Modal() {
	if (connectingProvider.value === 's3') return;
	isS3ModalOpen.value = false;
}

async function connectS3(payload) {
	connectingProvider.value = 's3';
	actionError.value = '';
	try {
		await api.connectS3Account(payload);
		await accountStore.loadAccounts();
		isS3ModalOpen.value = false;
	} catch (error) {
		actionError.value = error.message;
	} finally {
		connectingProvider.value = '';
	}
}

async function syncStorage() {
	if (isSyncing.value) return;
	isSyncing.value = true;
	actionError.value = '';
	actionSuccess.value = '';
	try {
		await api.runSync();
		await Promise.all([accountStore.loadAccounts(), loadAllocation()]);
		actionSuccess.value = t('storage.syncSuccess');
	} catch (error) {
		actionError.value = error.message;
	} finally {
		isSyncing.value = false;
	}
}

async function disconnectAccount(account) {
	if (!window.confirm(t('storage.disconnectConfirm', { provider: providerLabel(account.provider), email: account.email }))) return;
	await accountStore.disconnectAccount(account.id);
}

onMounted(async () => {
	if (route.query.connected === '1') {
		actionSuccess.value = t('storage.accountConnected');
		await router.replace({ path: route.path, query: {} });
	}
	await loadPage();
});
</script>

<template>
	<DriveShell current-section="storage">
		<div class="mx-auto flex w-full max-w-[1240px] flex-1 flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
			<section class="overflow-hidden rounded-3xl border border-[#dfe6f1] bg-white shadow-[0_10px_32px_rgba(60,64,67,0.08)] dark:border-[#272e39] dark:bg-[#12161d]">
				<div class="flex flex-col gap-5 p-6 lg:flex-row lg:items-end lg:justify-between">
					<div>
						<p class="text-xs font-semibold uppercase tracking-[0.16em] text-[#5f6368] dark:text-slate-400">{{ t('storage.title') }}</p>
						<div class="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
							<h1 class="text-2xl font-semibold text-[#202124] dark:text-slate-100">{{ usedTotalLabel }}</h1>
							<span class="text-sm text-[#5f6368] dark:text-slate-400">{{ freeFormatted }} {{ t('storage.free') }}</span>
						</div>
						<p class="mt-2 max-w-2xl text-sm text-[#5f6368] dark:text-slate-400">{{ t('storage.description') }}</p>
					</div>
					<button type="button" class="inline-flex items-center gap-2 rounded-2xl border border-[#dfe6f1] px-3.5 py-2.5 text-sm font-medium text-[#3c4043] transition hover:bg-[#f8fafd] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#272e39] dark:text-slate-200 dark:hover:bg-[#20262f]/70" :disabled="isSyncing" @click="syncStorage">
						<IconRefresh :size="17" :stroke="2" :class="isSyncing ? 'animate-spin' : ''" />
						{{ isSyncing ? t('storage.syncing') : t('storage.sync') }}
					</button>
				</div>

				<div class="px-6 pb-6">
					<div class="h-4 overflow-hidden rounded-full bg-[#edf2f7] dark:bg-slate-700">
						<div v-for="segment in storageSegments" :key="segment.key" class="inline-block h-full align-top" :class="segment.className" :style="{ width: segment.width }"></div>
					</div>
					<div class="mt-3 flex flex-wrap gap-3 text-xs text-[#5f6368] dark:text-slate-400">
						<span>{{ formatBytesStrict(totalUsed) }} {{ t('storage.used') }}</span>
						<span>·</span>
						<span>{{ formatBytesStrict(totalSpace) }} {{ t('storage.capacity') }}</span>
						<span>·</span>
						<span>{{ Math.round((totalSpace ? totalUsed / totalSpace : 0) * 100) }}%</span>
					</div>
				</div>
			</section>

			<div class="flex items-center gap-1 rounded-full border border-[#e0e3e7] bg-white p-1 shadow-[0_10px_32px_rgba(60,64,67,0.06)] dark:border-[#272e39] dark:bg-[#07090d] sm:w-fit">
				<button type="button" class="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition" :class="activeTab === 'overview'
					? 'bg-[#1a73e8] text-white shadow-sm dark:bg-sky-600'
					: 'text-[#5f6368] hover:text-[#202124] dark:text-slate-400 dark:hover:text-slate-200'" @click="activeTab = 'overview'">
					<IconChartPie :size="18" :stroke="1.9" />
					<span>{{ t('storage.tabOverview') }}</span>
				</button>
				<button type="button" class="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition" :class="activeTab === 'allocation'
					? 'bg-[#1a73e8] text-white shadow-sm dark:bg-sky-600'
					: 'text-[#5f6368] hover:text-[#202124] dark:text-slate-400 dark:hover:text-slate-200'" @click="activeTab = 'allocation'">
					<IconAdjustments :size="18" :stroke="1.9" />
					<span>{{ t('storage.tabAllocation') }}</span>
				</button>
			</div>

			<section v-show="activeTab === 'overview'" class="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.8fr)]">
				<div class="rounded-3xl border border-[#dfe6f1] bg-white p-6 shadow-[0_10px_32px_rgba(60,64,67,0.06)] dark:border-[#272e39] dark:bg-[#12161d]">
					<div class="flex items-center justify-between gap-4">
						<div>
							<h2 class="text-base font-semibold text-[#202124] dark:text-slate-100">{{ t('storage.accountsTitle') }}</h2>
							<p class="mt-1 text-sm text-[#5f6368] dark:text-slate-400">{{ t('storage.accountsDescription') }}</p>
						</div>
						<div class="text-sm font-medium text-[#5f6368] dark:text-slate-400">{{ accounts.length }}</div>
					</div>

					<div v-if="isLoading" class="mt-6 text-sm text-[#5f6368] dark:text-slate-400">{{ t('storage.loadingAccounts') }}</div>
					<div v-else-if="error" class="mt-6 rounded-2xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{{ error }}</div>
					<div v-else-if="!accounts.length" class="mt-6 rounded-2xl border border-dashed border-[#dfe6f1] p-6 text-sm text-[#5f6368] dark:border-[#272e39] dark:text-slate-400">{{ t('storage.noAccounts') }}</div>
					<div v-else class="mt-6 space-y-3">
						<div v-for="account in accounts" :key="account.id" class="flex items-center gap-3 rounded-2xl border border-[#edf0f4] p-3 dark:border-[#272e39]">
							<div class="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-[#f8fafd] dark:bg-[#07090d]/60">
								<img v-if="providerIcon(account.provider)" :src="providerIcon(account.provider)" :alt="providerLabel(account.provider)" class="size-5 object-contain" />
								<IconCloud v-else :size="19" />
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<TruncateMarquee as="p" class="min-w-0 text-sm font-medium text-[#202124] dark:text-slate-100" :text="providerLabel(account.provider)" />
									<span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" :class="providerBadgeClass(account.status)">{{ account.status }}</span>
								</div>
								<TruncateMarquee as="p" class="mt-0.5 min-w-0 text-xs text-[#5f6368] dark:text-slate-400" :text="account.email || '—'" />
							</div>
							<div class="flex shrink-0 items-center gap-3">
								<div class="text-right text-xs text-[#5f6368] dark:text-slate-400">
									<div class="font-medium text-[#202124] dark:text-slate-200">{{ formatBytesStrict(account.used_space || 0) }}</div>
									<div>{{ formatBytesStrict(account.total_space || 0) }}</div>
								</div>
								<button type="button" class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium disabled:opacity-60 dark:bg-[#12161d]" :class="isReconnectable(account)
									? 'border-[#c7dafc] text-[#1a73e8] dark:border-sky-900/50 dark:text-sky-300'
									: 'border-[#f3c7c4] text-[#c5221f] dark:border-red-900/50 dark:text-red-300'" :disabled="isAccountActionBusy(account)" @click="handleAccountAction(account)">
									<IconPlugConnected v-if="isReconnectable(account)" :size="15" :stroke="2" />
									<IconPlugConnectedX v-else :size="15" :stroke="2" />
									<span>{{ accountActionLabel(account) }}</span>
								</button>
							</div>
						</div>
					</div>
				</div>

				<div class="rounded-3xl border border-[#dfe6f1] bg-white p-6 shadow-[0_10px_32px_rgba(60,64,67,0.06)] dark:border-[#272e39] dark:bg-[#12161d]">
					<h2 class="text-base font-semibold text-[#202124] dark:text-slate-100">{{ t('storage.connectTitle') }}</h2>
					<p class="mt-1 text-sm text-[#5f6368] dark:text-slate-400">{{ t('storage.connectDescription') }}</p>
					<div class="mt-5 grid gap-2">
						<button v-for="option in providerConnectOptions" :key="option.key" type="button" class="flex items-center gap-3 rounded-2xl border border-[#edf0f4] px-3 py-3 text-left text-sm transition hover:bg-[#f8fafd] disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#272e39] dark:hover:bg-[#20262f]/70" :disabled="connectingProvider === option.key" @click="option.action">
							<img v-if="option.icon" :src="option.icon" :alt="option.label" class="size-5 object-contain" />
							<span class="flex-1 font-medium text-[#202124] dark:text-slate-100">{{ connectingProvider === option.key ? option.busyLabel : option.label }}</span>
							<IconChevronDown :size="15" class="-rotate-90 text-[#9aa0a6]" />
						</button>
					</div>
					<div v-if="actionError" class="mt-4 rounded-2xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{{ actionError }}</div>
					<div v-if="actionSuccess" class="mt-4 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">{{ actionSuccess }}</div>
				</div>
			</section>

			<section v-show="activeTab === 'allocation'" class="rounded-3xl border border-[#dfe6f1] bg-white p-6 shadow-[0_10px_32px_rgba(60,64,67,0.06)] dark:border-[#272e39] dark:bg-[#12161d]">
				<div class="flex flex-col gap-1">
					<h2 class="text-lg font-medium text-[#202124] dark:text-slate-100">{{ t('allocation.title') }}</h2>
					<p class="text-sm text-[#5f6368] dark:text-slate-400">{{ t('allocation.subtitle') }}</p>
				</div>

				<div v-if="!accounts.length" class="mt-4 rounded-2xl border border-dashed border-[#dadce0] bg-[#f8fafd] px-4 py-6 text-center text-sm text-[#5f6368] dark:border-[#272e39] dark:bg-[#141821]/60 dark:text-slate-400">
					{{ t('allocation.noAccounts') }}
				</div>

				<template v-else>
					<div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
						<button v-for="option in allocationStrategyOptions" :key="option.key" type="button" class="flex flex-col gap-1 rounded-2xl border p-4 text-left transition" :class="selectedStrategy === option.key
							? 'border-[#1a73e8] bg-[#e8f0fe] dark:border-sky-500 dark:bg-sky-950/30'
							: 'border-[#e3e8ee] bg-[#f8fafd] hover:border-[#c7dafc] dark:border-[#272e39] dark:bg-[#141821]/70 dark:hover:border-sky-900/60'" @click="selectStrategy(option.key)">
							<span class="flex items-center justify-between gap-2">
								<span class="text-sm font-semibold" :class="selectedStrategy === option.key ? 'text-[#1a73e8] dark:text-sky-300' : ''">{{ option.label }}</span>
								<IconCheck v-if="selectedStrategy === option.key" :size="18" :stroke="2.2" class="text-[#1a73e8] dark:text-sky-300" />
							</span>
							<span class="text-xs leading-relaxed text-[#5f6368] dark:text-slate-400">{{ option.description }}</span>
						</button>
					</div>

					<div class="mt-5 rounded-2xl border border-[#e3e8ee] bg-[#f8fafd] p-4 dark:border-[#272e39] dark:bg-[#141821]/70" :class="selectedStrategy === 'manual' ? '' : 'opacity-80'">
						<div class="flex items-center justify-between gap-3">
							<h3 class="text-sm font-semibold text-[#202124] dark:text-slate-100">{{ t('allocation.orderTitle') }}</h3>
						</div>
						<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('allocation.reorderHint') }}</p>

						<ul class="mt-3 grid gap-2">
							<li v-for="(account, index) in orderedAllocationAccounts" :key="account.id" draggable="true" class="flex items-center gap-3 rounded-xl border border-[#e3e8ee] bg-white px-3 py-2.5 dark:border-[#272e39] dark:bg-[#07090d]/70" :class="dragIndex === index ? 'ring-2 ring-[#1a73e8] dark:ring-sky-500' : ''" @dragstart="onDragStart(index)" @dragover="onDragOver(index, $event)" @dragend="onDragEnd">
								<span class="cursor-grab text-[#9aa0a6] active:cursor-grabbing dark:text-slate-500"><IconGripVertical :size="18" :stroke="1.8" /></span>
								<span class="grid size-7 shrink-0 place-items-center rounded-full bg-[#e8f0fe] text-xs font-semibold text-[#1a73e8] dark:bg-[#12161d] dark:text-sky-300">{{ index + 1 }}</span>
								<div class="flex size-8 shrink-0 items-center justify-center rounded-xl bg-[#f1f3f4] dark:bg-[#12161d]">
									<img v-if="providerIcon(account.provider)" :src="providerIcon(account.provider)" :alt="providerLabel(account.provider)" class="size-4 object-contain" />
								</div>
								<div class="min-w-0 flex-1">
									<TruncateMarquee as="p" class="text-sm font-medium text-[#202124] dark:text-slate-100" :text="account.email" />
									<p class="text-xs text-[#5f6368] dark:text-slate-400">{{ providerLabel(account.provider) }} · {{ formatBytesStrict(Number(account.total_space) - Number(account.used_space)) }} {{ t('storage.free').toLowerCase() }}</p>
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<button type="button" class="grid size-8 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#f1f3f4] disabled:opacity-40 dark:text-slate-400 dark:hover:bg-[#1b2029]" :disabled="index === 0" :title="t('allocation.moveUp')" @click="moveAccount(index, -1)"><IconArrowUp :size="16" :stroke="2" /></button>
									<button type="button" class="grid size-8 place-items-center rounded-full text-[#5f6368] transition hover:bg-[#f1f3f4] disabled:opacity-40 dark:text-slate-400 dark:hover:bg-[#1b2029]" :disabled="index === orderedAllocationAccounts.length - 1" :title="t('allocation.moveDown')" @click="moveAccount(index, 1)"><IconArrowDown :size="16" :stroke="2" /></button>
								</div>
							</li>
						</ul>
					</div>

					<div class="mt-4 flex flex-wrap items-center justify-end gap-3">
						<span v-if="allocationSaved" class="inline-flex items-center gap-1.5 text-sm text-[#188038] dark:text-emerald-400"><IconCheck :size="16" :stroke="2.2" />{{ t('allocation.saved') }}</span>
						<button type="button" class="inline-flex items-center gap-2 rounded-full bg-[#1a73e8] px-4 py-2 text-white disabled:opacity-60" :disabled="isSavingAllocation || isAllocationLoading" @click="saveAllocation">
							<IconDeviceFloppy :size="18" :stroke="2" />
							<span>{{ isSavingAllocation ? t('allocation.saving') : t('allocation.save') }}</span>
						</button>
					</div>

					<p v-if="allocationError" class="mt-3 rounded-2xl bg-[#fce8e6] px-4 py-3 text-sm text-[#c5221f] dark:bg-red-950/40 dark:text-red-300">{{ allocationError }}</p>
				</template>
			</section>
		</div>
	</DriveShell>

	<MegaConnectModal :open="isMegaModalOpen" :is-connecting="connectingProvider === 'mega'" @close="closeMegaModal" @connect="connectMega" />
	<S3ConnectModal :open="isS3ModalOpen" :is-connecting="connectingProvider === 's3'" @close="closeS3Modal" @connect="connectS3" />
</template>
