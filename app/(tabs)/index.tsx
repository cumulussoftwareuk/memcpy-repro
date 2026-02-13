import ParallaxScrollView from "@/components/parallax-scroll-view";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { Fonts } from "@/constants/theme";
import {
  cryptoWaitReady,
  mnemonicGenerate,
  randomAsU8a,
} from "@polkadot/util-crypto";
import { useState } from "react";
import { Button, Platform, StyleSheet, Text } from "react-native";

// ---------------------------------------------------------------------------
// The crash: __memcpy_aarch64_simd inside expo::JavaScriptTypedArray::writeBuffer
// called from expo.modules.crypto.CryptoModule.getRandomValues.
//
// Root cause: Hermes' concurrent/incremental GC relocates an ArrayBuffer's
// backing store while the native writeBuffer code still holds a raw pointer
// obtained *before* the GC compaction. The memcpy then writes to freed memory.
//
// To reproduce we need:
//  1. Moderate memory pressure so GC compacts ArrayBuffers (but doesn't
//     corrupt the entire Hermes heap — too much pressure causes unrelated
//     crashes in the bytecode interpreter / UI event dispatch)
//  2. Many tight getRandomValues calls on freshly-allocated TypedArray views
//  3. Offset views into larger ArrayBuffers (more likely to be relocated)
//  4. Microtask yields so GC gets a chance to compact between native calls
//
// IMPORTANT: Avoid extreme allocation bursts (>10k objects) — these corrupt
// Hermes internals and crash in the interpreter rather than in writeBuffer.
// ---------------------------------------------------------------------------

/**
 * Allocate & immediately discard ArrayBuffers to encourage GC to run
 * and compact/relocate backing stores. Keep intensity moderate to avoid
 * corrupting Hermes' own heap structures.
 */
function gcPressure(intensity: number = 2000) {
  const trash: ArrayBuffer[] = [];
  for (let i = 0; i < intensity; i++) {
    // Use sizes similar to what getRandomValues allocates (32–512 bytes)
    // so GC treats them as the same generation/segment as our target buffers
    trash.push(new ArrayBuffer(256 + ((i * 37) % 512)));
  }
  trash.length = 0;
}

/** Longer yield that gives Hermes GC time to finalize without racing UI */
function yieldToGC(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Strategy 1 — Polkadot WASM crypto init under GC pressure
 *
 * The original crash happened during polkadot crypto operations.
 * cryptoWaitReady() / initBridge() internally calls getRandomValues many
 * times during WASM self-test. We re-init the WASM bridge repeatedly while
 * flooding the allocator so concurrent GC overlaps with native memcpy.
 */
async function polkadotWasmStress() {
  console.log("[polkadot] Starting WASM crypto stress...");

  for (let i = 0; i < 80; i++) {
    console.log(`[polkadot] Starting iteration ${i}/80...`);

    // Moderate allocation burst — target ArrayBuffer-sized objects
    gcPressure(4000);

    // Fire off concurrent chains that all funnel through getRandomValues.
    // Keep chain count low (3) to avoid overwhelming Hermes' heap.
    const tasks: Promise<unknown>[] = [];

    console.log(
      `[polkadot] Allocation burst completed for iteration ${i}/80...`,
    );

    // Chain A: WASM bridge init (calls getRandomValues internally)
    tasks.push(
      cryptoWaitReady().catch((e: unknown) =>
        console.warn("[polkadot] cryptoWaitReady error:", e),
      ),
    );

    console.log(`[polkadot] cryptoWaitReady started for iteration ${i}/80`);

    // Chain B: Generate mnemonics (uses randomAsU8a → getRandomValues)
    tasks.push(
      (async () => {
        for (let j = 0; j < 30; j++) {
          try {
            mnemonicGenerate(24);
            randomAsU8a(64);
          } catch {
            /* swallow — we want volume not correctness */
          }
          // Light allocation between mnemonic generations
          const junk = Array.from({ length: 200 }, () => new Uint8Array(256));
          junk.length = 0;
        }
      })(),
    );

    console.log(`[polkadot] Mnemonic generation started for iteration ${i}/80`);

    // Chain C: Raw getRandomValues on offset views concurrent with WASM init
    // This is the exact path the production crash hits:
    //   new ArrayBuffer → Uint8Array(buf, offset, len) → getRandomValues
    tasks.push(
      (async () => {
        for (let j = 0; j < 150; j++) {
          const buf = new ArrayBuffer(256);
          crypto.getRandomValues(new Uint8Array(buf, 16, 64));
          crypto.getRandomValues(new Uint8Array(buf, 128, 64));
          // Nudge GC with small allocation bursts
          if (j % 15 === 0) {
            const g = Array.from({ length: 300 }, () => new ArrayBuffer(256));
            g.length = 0;
          }
        }
      })(),
    );

    console.log(`[polkadot] Raw getRandomValues started for iteration ${i}/80`);

    await Promise.all(tasks);

    console.log(`[polkadot] All tasks completed for iteration ${i}/80`);

    // Extra getRandomValues after the concurrent work completes
    for (let k = 0; k < 50; k++) {
      const ab = new ArrayBuffer(128);
      crypto.getRandomValues(new Uint8Array(ab, 0, 64));
      crypto.getRandomValues(new Uint8Array(ab, 64, 64));
    }

    console.log(
      `[polkadot] Extra getRandomValues completed for iteration ${i}/80`,
    );

    // Yield long enough for GC to finalize and UI thread to stay stable
    //await yieldToGC(i % 10 === 0 ? 15 : 5);

    if (i % 10 === 0) {
      console.log(`[polkadot] iteration ${i}/80`);
    }
  }
  console.log("[polkadot] Completed without crash");
}

/**
 * Strategy 2 — Maximum contention: many concurrent async chains all calling
 * getRandomValues on shared-buffer views while allocating aggressively.
 *
 * The idea is to maximise the chance that Hermes' background GC thread
 * compacts an ArrayBuffer while the native expo-crypto writeBuffer holds
 * a stale pointer to its pre-compaction address.
 */
async function maxContentionStress() {
  console.log("[contention] Starting max contention stress...");
  // Reduced from 8 to 4 chains — too many concurrent chains corrupt Hermes'
  // internal heap rather than just triggering ArrayBuffer relocation
  const NUM_CHAINS = 4;
  const ITERATIONS = 400;

  const chain = async (id: number) => {
    for (let i = 0; i < ITERATIONS; i++) {
      // Allocate a shared backing buffer with multiple offset views.
      // Each getRandomValues call goes through:
      //   expo::JavaScriptTypedArray::writeBuffer → memcpy(basePtr + offset, ...)
      // If GC relocates the backing store between basePtr extraction and memcpy,
      // the pointer is stale and the memcpy crashes.
      const shared = new ArrayBuffer(1024);
      const views = [
        new Uint8Array(shared, 0, 128),
        new Uint8Array(shared, 128, 128),
        new Uint8Array(shared, 256, 256),
        new Uint8Array(shared, 512, 256),
        new Uint8Array(shared, 768, 256),
      ];

      for (const v of views) {
        crypto.getRandomValues(v);
      }

      // Moderate GC pressure — only ArrayBuffer-shaped allocations so GC
      // targets the same heap segment as our getRandomValues buffers
      if (i % 3 === 0) {
        const mix: ArrayBuffer[] = [];
        for (let j = 0; j < 150; j++) {
          mix.push(new ArrayBuffer(128 + ((j * 31) % 384)));
        }
        mix.length = 0;
      }

      // Yield more frequently (every 3 iterations) to give GC compaction
      // windows without starving the event loop
      if (i % 3 === 0) {
        await yieldToGC(2);
      }
    }
    console.log(`[contention] chain ${id} done`);
  };

  await Promise.all(Array.from({ length: NUM_CHAINS }, (_, i) => chain(i)));
  console.log("[contention] Completed without crash");
}

/**
 * Combined reproduction — runs all strategies sequentially, then in parallel
 */
async function fullReproduction() {
  console.log("=== Starting full memcpy crash reproduction ===");
  console.log("Running on:", Platform.OS);

  // Warm up polkadot WASM
  await cryptoWaitReady();
  console.log("WASM crypto ready, starting stress tests...");

  // Run each strategy sequentially first
  await polkadotWasmStress();
  await yieldToGC(50);
  await maxContentionStress();
  await yieldToGC(50);

  // Run both strategies in parallel
  console.log("=== Running polkadot + contention in parallel ===");
  await Promise.all([polkadotWasmStress(), maxContentionStress()]);

  console.log("=== All tests completed without crash ===");
}

export default function TabThreeScreen() {
  const [status, setStatus] = useState("");

  const runTest = (name: string, fn: () => Promise<void>) => async () => {
    setStatus(`Running: ${name}...`);
    try {
      await fn();
      setStatus(`Done: ${name}`);
    } catch (e: unknown) {
      setStatus(`Error: ${e}`);
    }
  };

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: "#D0D0D0", dark: "#353636" }}
      headerImage={
        <IconSymbol
          size={310}
          color="#808080"
          name="chevron.left.forwardslash.chevron.right"
          style={styles.headerImage}
        />
      }
    >
      <ThemedView style={styles.titleContainer}>
        <ThemedText
          type="title"
          style={{
            fontFamily: Fonts.rounded,
          }}
        >
          Memcpy Test
        </ThemedText>
      </ThemedView>
      <ThemedText>
        Each test hammers crypto.getRandomValues on offset TypedArray views
        under heavy GC pressure to trigger the native memcpy crash.
      </ThemedText>
      {status ? <Text style={styles.status}>{status}</Text> : null}
      <Button
        onPress={runTest("Full Reproduction", fullReproduction)}
        title="Run Full Reproduction (all strategies)"
      />
      <Button
        onPress={runTest("Polkadot WASM Stress", polkadotWasmStress)}
        title="1. Polkadot WASM Crypto Stress"
      />
      <Button
        onPress={runTest("Max Contention", maxContentionStress)}
        title="2. Max Contention (4 chains)"
      />
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  headerImage: {
    color: "#808080",
    bottom: -90,
    left: -35,
    position: "absolute",
  },
  titleContainer: {
    flexDirection: "row",
    gap: 8,
  },
  status: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#888",
    paddingVertical: 4,
  },
});
