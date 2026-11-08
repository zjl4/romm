<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import type { Nostalgist } from "nostalgist";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import PlayerShell from "@/components/Player/PlayerShell.vue";
import { useDeviceSaveSync } from "@/composables/useDeviceSaveSync";
import { useFullscreenPref } from "@/composables/useFullscreenPref";
import { useIsAlive } from "@/composables/useIsAlive";
import {
  hasSharedArrayBuffer,
  isRelaunchMarker,
  useIsolatedLaunch,
} from "@/composables/useIsolatedLaunch";
import { usePlaySession } from "@/composables/usePlaySession";
import { usePlayerExit } from "@/composables/usePlayerExit";
import { usePlayerFullscreen } from "@/composables/usePlayerFullscreen";
import { usePlayerHero } from "@/composables/usePlayerHero";
import { useSnackbar } from "@/composables/useSnackbar";
import { usePlayingWhile } from "@/composables/useStageActive";
import { useUnloadGuard } from "@/composables/useUnloadGuard";
import { RSwitch } from "@/lib";
import romApi from "@/services/api/rom";
import storeAuth from "@/stores/auth";
import type { DetailedRom } from "@/stores/roms";
import { getDownloadPath } from "@/utils";
import {
  cacheMkxpzGame,
  deleteMkxpzSaves,
  ensureMkxpzDirectories,
  MKXPZ_MOUNT,
  mkxpzGameFile,
  mkxpzPaths,
  mkxpzProfile,
  readMkxpzSaves,
  writeMkxpzSaves,
} from "@/utils/mkxpzStorage";
import type { LocalSave } from "@/utils/saveSync";
import { bytesEqual } from "@/utils/saveSync/hash";

// Pinned in the image beside the other web players (docker/Dockerfile).
const CORE_BASE = "/assets/mkxpz";
const CORE_NAME = "mkxp-z";

const { t } = useI18n();
const authStore = storeAuth();
const { fullscreenOnPlay } = useFullscreenPref();
const playSession = usePlaySession();
const snackbar = useSnackbar();
const alive = useIsAlive();
// The core's threads keep the document, so leaving hands the tab a fresh one.
let runtimeBound = false;
const exit = usePlayerExit(() => runtimeBound);

const rom = shallowRef<DetailedRom | null>(null);
const gameRunning = ref(false);
usePlayingWhile(gameRunning);
const preparing = ref(false);
// Set only while the game downloads; a cached game starts without one.
const downloadPercent = ref<number | null>(null);
const quitting = ref(false);
const stage = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const { enter: enterFullscreen } = usePlayerFullscreen(stage);

let nostalgist: Nostalgist | null = null;

const { romId, heroRom, title, platformLabel } = usePlayerHero(rom);

const {
  intent: relaunched,
  relaunching,
  relaunch: relaunchIsolated,
} = useIsolatedLaunch<true>("mkxpz", romId, isRelaunchMarker);

const profile = computed(() => mkxpzProfile(romId, authStore.user?.id ?? 0));

const saveSync = useDeviceSaveSync({
  emulator: "mkxpz",
  read: () => readMkxpzSaves(profile.value),
});

// Only the files whose bytes differ, so the core keeps its own timestamps.
// `saves` began as every file the core held, so a missing one sync deleted.
async function restoreSaves(saves: LocalSave[]) {
  const held = await readMkxpzSaves(profile.value);
  const kept = new Set(saves.map((save) => save.slot));
  await deleteMkxpzSaves(
    profile.value,
    held.filter((save) => !kept.has(save.slot)).map((save) => save.slot),
  );
  const bytesBySlot = new Map(held.map((save) => [save.slot, save.bytes]));
  await writeMkxpzSaves(
    profile.value,
    saves.filter(
      (save) => !bytesEqual(bytesBySlot.get(save.slot) ?? null, save.bytes),
    ),
  );
}

// RetroArch would otherwise file saves and states under a folder named after
// the core, one level below where `readMkxpzSaves` looks.
const UNSORTED_SAVES: Record<string, boolean> = {
  sort_savefiles_enable: false,
  sort_savestates_enable: false,
  sort_savefiles_by_content_enable: false,
  sort_savestates_by_content_enable: false,
};

// XP games read Z and C where VX and VX Ace read Z and Shift.
function inputConfig(xp: boolean) {
  return {
    input_menu_toggle: "f1",
    input_player1_a: xp ? "c" : "z",
    input_player1_b: "x",
    input_player1_x: xp ? "z" : "shift",
    input_player1_y: "a",
    input_player1_l3: "s",
    input_player1_r3: "d",
    input_player1_l: "q",
    input_player1_r: "w",
    input_player1_l2: "ctrl",
    input_player1_r2: "rshift",
    input_player1_start: "alt",
  };
}

async function onPlay() {
  const currentRom = rom.value;
  const userId = authStore.user?.id;
  if (!currentRom || userId == null || preparing.value) return;

  if (!hasSharedArrayBuffer()) {
    if (!relaunchIsolated(true)) snackbar.error(t("play.https-required"));
    return;
  }

  preparing.value = true;
  let gameFile: string;
  try {
    const saves = await saveSync.prepare(
      currentRom,
      await readMkxpzSaves(profile.value),
    );
    if (saves) await restoreSaves(saves);
  } catch (error) {
    console.error("[mkxp-z] Save storage failed", error);
    snackbar.error(t("play.mkxpz-saves-load-failed"));
    preparing.value = false;
    return;
  }
  try {
    gameFile = await mkxpzGameFile(currentRom.id, currentRom.files);
    await cacheMkxpzGame(
      currentRom.id,
      gameFile,
      getDownloadPath({ rom: currentRom, purpose: "play" }),
      currentRom.files.reduce((sum, file) => sum + file.file_size_bytes, 0),
      (received, total) => {
        // The zip's headers push past the files' own sizes, so 100 waits for the end.
        downloadPercent.value = total
          ? Math.min(99, Math.floor((received / total) * 100))
          : null;
      },
    );
  } catch (error) {
    console.error("[mkxp-z] Game download failed", error);
    snackbar.error(t("play.stream-error-generic"));
    return;
  } finally {
    preparing.value = false;
    downloadPercent.value = null;
  }
  if (!alive.value) return;

  saveSync.start();
  gameRunning.value = true;

  await nextTick();
  if (!canvas.value) {
    gameRunning.value = false;
    return;
  }
  // The core sizes its canvas while it starts, so the stage settles first.
  if (fullscreenOnPlay.value) {
    await enterFullscreen();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!alive.value || !canvas.value) return;
  }

  const paths = mkxpzPaths(profile.value, gameFile);
  try {
    await ensureMkxpzDirectories(paths);
    runtimeBound = true;
    const runtime = await import("nostalgist");
    nostalgist = await runtime.Nostalgist.prepare({
      core: {
        name: CORE_NAME,
        js: `${CORE_BASE}/mkxp-z_libretro.js`,
        wasm: `${CORE_BASE}/mkxp-z_libretro.wasm`,
      },
      element: canvas.value,
      emscriptenModule: {
        preRun: [
          (module: { ENV: Record<string, string> }) => {
            module.ENV.OPFS_MOUNT = MKXPZ_MOUNT;
          },
        ],
      },
      retroarchConfig: {
        savefile_directory: paths.saveDirectory,
        savestate_directory: paths.stateDirectory,
        system_directory: paths.systemDirectory,
        ...UNSORTED_SAVES,
        ...inputConfig(currentRom.mkxpz_engine === "xp"),
      },
      retroarchCoreConfig: {
        "mkxp-z_saveStateSize": "256",
      },
    });
    // RetroArch loads its content from the command line, here a path on OPFS.
    const module = nostalgist.getEmscripten().Module as {
      arguments?: string[];
    };
    module.arguments = [...(module.arguments ?? []), paths.game];
    await nostalgist.start();
  } catch (error) {
    console.error("[mkxp-z] Core failed to start", error);
    snackbar.error(t("play.stream-error-generic"));
    return;
  }

  playSession.start(currentRom);
}

function stopCore() {
  const running = nostalgist;
  nostalgist = null;
  try {
    running?.exit({ removeCanvas: false });
  } catch (error) {
    console.error("[mkxp-z] Stop failed", error);
  }
}

function teardown() {
  saveSync.stop();
  playSession.flush();
  stopCore();
}

async function leavePlayer(destination: string) {
  if (quitting.value) return;
  quitting.value = true;

  if (!(await saveSync.flush())) {
    if (!(await saveSync.confirmDiscard())) {
      quitting.value = false;
      return;
    }
  }

  teardown();
  exit.leave(destination);
}

function onlyQuit() {
  void leavePlayer(`/rom/${romId}`);
}

useUnloadGuard(() => gameRunning.value && !quitting.value);

onMounted(async () => {
  const romResponse = await romApi.getRom({ romId });
  if (!alive.value) return;
  rom.value = romResponse.data;

  if (relaunched) void onPlay();
});

onBeforeRouteLeave((to) => {
  if (!saveSync.isActive()) return exit.guard(to);
  void leavePlayer(to.fullPath);
  return false;
});

useEventListener(window, "pagehide", () => playSession.flush());

onBeforeUnmount(teardown);
</script>

<template>
  <PlayerShell
    :hero-rom="heroRom"
    :title="title"
    :platform-label="platformLabel"
    :rom-id="romId"
    :ready="!!rom && !relaunching && !preparing"
    :running="gameRunning"
    :quitting="quitting"
    @play="onPlay"
    @quit="onlyQuit"
  >
    <template #settings>
      <RSwitch v-model="fullscreenOnPlay" :label="t('play.full-screen')" />
      <p
        v-if="downloadPercent !== null"
        class="r-mkxpz__progress"
        role="status"
      >
        {{ t("play.native-downloading", { percent: downloadPercent }) }}
      </p>
    </template>

    <template #brand>
      <div class="r-mkxpz__brand">
        <span>{{ t("play.powered-by") }}</span>
        <span class="r-mkxpz__brand-name">mkxp-z</span>
      </div>
    </template>

    <template #stage>
      <div ref="stage" class="r-mkxpz__stage">
        <canvas
          ref="canvas"
          class="r-mkxpz__canvas"
          :aria-label="t('play.mkxpz-screen')"
        />
      </div>
    </template>
  </PlayerShell>
</template>

<style scoped>
.r-mkxpz__progress {
  margin: 0;
  font-size: var(--r-font-size-sm);
  color: var(--r-color-fg-secondary);
  text-align: center;
}

.r-mkxpz__brand {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  font-size: var(--r-font-size-xs);
  color: var(--r-color-fg-faint);
  font-style: italic;
}
.r-mkxpz__brand-name {
  font-style: normal;
  font-weight: 600;
  color: var(--r-color-fg-secondary);
}

.r-mkxpz__stage {
  width: 100%;
  height: 100%;
}
.r-mkxpz__canvas {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
