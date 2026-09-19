/* ==========================================================================
   fallback-chroma.js – Chroma-Berechnung ohne WebAssembly
   --------------------------------------------------------------------------
   Wird verwendet, wenn Essentia.js nicht geladen werden kann oder zur
   Laufzeit einen Fehler meldet. Grundlage ist die FFT des AnalyserNode
   der Web Audio API.

   Vorgehen je Frame:
     1. Betragsspektrum in dB vom AnalyserNode lesen
     2. Nur lokale Maxima (Spektralspitzen) oberhalb einer Dynamikgrenze
     3. Jede Spitze auf die nächstgelegene Tonklasse abbilden
        (MIDI-Nummer = 69 + 12 · log2(f / 440 Hz))
     4. Gewichtung mit cos² der Abweichung vom Halbtonraster,
        analog zur „squaredCosine“-Gewichtung von HPCP
     5. Energie (Betrag²) je Tonklasse aufsummieren, auf Maximum normieren
   ========================================================================== */

(function (global) {
  'use strict';

  class FallbackChroma {
    /**
     * @param {AnalyserNode} analyser
     * @param {number} abtastrate  Abtastrate des AudioContext in Hz
     * @param {{minFrequenz:number, maxFrequenz:number, dynamikDb:number, referenz:number}} optionen
     */
    constructor(analyser, abtastrate, optionen) {
      const o = Object.assign(
        { minFrequenz: 80, maxFrequenz: 4000, dynamikDb: 60, referenz: 440 },
        optionen || {}
      );
      this.analyser = analyser;
      this.dynamikDb = o.dynamikDb;
      this.db = new Float32Array(analyser.frequencyBinCount);
      this.tonklasse = new Int8Array(analyser.frequencyBinCount).fill(-1);
      this.gewicht = new Float32Array(analyser.frequencyBinCount);

      // Zuordnung FFT-Bin → Tonklasse einmalig vorberechnen
      const binBreite = abtastrate / analyser.fftSize;
      for (let k = 1; k < this.db.length; k++) {
        const f = k * binBreite;
        if (f < o.minFrequenz || f > o.maxFrequenz) continue;
        const midi = 69 + 12 * Math.log2(f / o.referenz);
        const naechster = Math.round(midi);
        const abweichung = midi - naechster;            // −0,5 … +0,5 Halbtöne
        this.tonklasse[k] = ((naechster % 12) + 12) % 12; // 0 = C
        this.gewicht[k] = Math.pow(Math.cos(Math.PI * abweichung), 2);
      }
    }

    /** @returns {Float32Array} Chroma-Vektor, Index 0 = C, Maximum = 1 */
    berechne() {
      const db = this.db;
      this.analyser.getFloatFrequencyData(db);

      let maxDb = -Infinity;
      for (let k = 0; k < db.length; k++) {
        if (this.tonklasse[k] >= 0 && db[k] > maxDb) maxDb = db[k];
      }

      const chroma = new Float32Array(12);
      if (!isFinite(maxDb)) return chroma;
      const untergrenze = maxDb - this.dynamikDb;

      for (let k = 1; k < db.length - 1; k++) {
        const tk = this.tonklasse[k];
        if (tk < 0) continue;
        const d = db[k];
        if (d < untergrenze || d <= db[k - 1] || d < db[k + 1]) continue; // nur Spitzen
        const betrag = Math.pow(10, d / 20);
        chroma[tk] += betrag * betrag * this.gewicht[k];
      }

      let max = 0;
      for (let i = 0; i < 12; i++) if (chroma[i] > max) max = chroma[i];
      if (max > 0) for (let i = 0; i < 12; i++) chroma[i] /= max;
      return chroma;
    }
  }

  global.FallbackChroma = FallbackChroma;
})(typeof window !== 'undefined' ? window : globalThis);
