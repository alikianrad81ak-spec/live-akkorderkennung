/* ==========================================================================
   app.js – Hauptlogik der Live-Akkorderkennung
   --------------------------------------------------------------------------
   Signalkette (Quelle: Mikrofon oder hochgeladene Audiodatei):
     Mikrofon (getUserMedia) bzw. Audiodatei (<audio> + MediaElementSource)
       → MediaStreamSource / MediaElementSource
       → ScriptProcessorNode (Puffer 4096)  → Essentia.js HPCP  ─┐
       → AnalyserNode (FFT 8192)            → FFT-Chroma (Fallback)┤
                                                                   ↓
                                        Glättung → Template-Matching → Anzeige

   Die HPCP-Kette folgt der Real-Time-HPCP-Chroma-Demo der MTG:
     Windowing → Spectrum → SpectralPeaks → SpectralWhitening → HPCP
   ========================================================================== */

(function () {
  'use strict';

  // ------------------------------------------------------------------------
  // Konfiguration
  // ------------------------------------------------------------------------

  const KONFIG = {
    puffergroesse: 4096,
    essentiaVersion: '0.1.3',
    ladeTimeoutMs: 15000,
    glaettung: 0.35,      // Gewicht des neuen Frames im gleitenden Mittel
    stabilFrames: 3,      // so viele gleiche Ergebnisse in Folge, bevor die Anzeige wechselt
    minKonfidenz: 0.6,    // darunter gilt das Ergebnis als unklar
    monitorIntervallMs: 100,
    hpcp: {
      fensterTyp: 'blackmanharris62',
      minFrequenz: 60,
      maxFrequenz: 4000,
      maxPeaks: 100,
      bandSplit: 500,
      harmonische: 0,
      referenz: 440,
      groesse: 12
    },
    fallback: {
      fftGroesse: 8192,
      minFrequenz: 80,
      maxFrequenz: 4000,
      dynamikDb: 60
    }
  };

  const ESSENTIA_URLS = [
    'https://cdn.jsdelivr.net/npm/essentia.js@' + KONFIG.essentiaVersion + '/dist/essentia-wasm.web.js',
    'https://cdn.jsdelivr.net/npm/essentia.js@' + KONFIG.essentiaVersion + '/dist/essentia.js-core.js'
  ];

  const VERFAHREN_NAME = {
    essentia: 'Essentia.js HPCP (WebAssembly)',
    fallback: 'FFT-Chroma (AnalyserNode)'
  };

  // ------------------------------------------------------------------------
  // DOM-Elemente
  // ------------------------------------------------------------------------

  const $ = function (id) { return document.getElementById(id); };
  const el = {
    start: $('btnStart'),
    startText: $('btnStartText'),
    datei: $('btnDatei'),
    dateiText: $('btnDateiText'),
    dateiEingabe: $('dateiEingabe'),
    playerBox: $('playerBox'),
    player: $('player'),
    dateiName: $('dateiName'),
    quelle: $('wQuelle'),
    stop: $('btnStop'),
    rad: $('chromaRad'),
    akkordBox: $('akkordBox'),
    symbol: $('akkordSymbol'),
    name: $('akkordName'),
    notation: $('selNotation'),
    schwelle: $('rngSchwelle'),
    schwelleAusgabe: $('outSchwelle'),
    fallbackErzwingen: $('chkFallback'),
    statusBox: $('statusBox'),
    status: $('statusText'),
    verfahren: $('wVerfahren'),
    rate: $('wRate'),
    frames: $('wFrames'),
    zeit: $('wZeit'),
    pegel: $('wPegel'),
    pegelBalken: $('pegelBalken'),
    kandidaten: $('kandidaten'),
    hpcpWerte: $('hpcpWerte'),
    protokoll: $('protokoll')
  };

  // ------------------------------------------------------------------------
  // Zustand
  // ------------------------------------------------------------------------

  const zustand = {
    laeuft: false,
    startetGerade: false,
    quellArt: 'mikrofon',       // 'mikrofon' | 'datei'
    mikrofonMoeglich: true,

    // Web Audio
    audioCtx: null,
    stream: null,
    quelle: null,
    analyser: null,
    prozessor: null,
    senke: null,
    audioEl: null,             // Audio-Element bei Dateianalyse
    dateiUrl: null,

    // Merkmalsextraktion
    essentia: null,
    essentiaStatus: 'laedt',   // 'laedt' | 'bereit' | 'fehler'
    essentiaPromise: null,
    hpcpVersatz: 9,            // HPCP-Bin 0 entspricht A (Referenz 440 Hz) → Tonklasse 9
    fallback: null,
    verfahren: null,           // 'essentia' | 'fallback'

    // Messwerte
    chroma: new Float32Array(12),  // geglättet, Index 0 = C
    rmsDb: -Infinity,
    frames: 0,
    rechenzeit: 0,
    kandidaten: [],

    // Stabilisierung der Anzeige
    kandidatId: null,
    kandidatZaehler: 0,
    anzeige: { id: 'bereit' },
    anzeigeGeaendert: true,

    // Einstellungen
    schwelleDb: -50,
    notation: 'international',

    // Darstellung
    rafId: null,
    letzterMonitor: 0
  };

  const zahl = function (wert, stellen) {
    return wert.toLocaleString('de-DE', {
      minimumFractionDigits: stellen,
      maximumFractionDigits: stellen
    });
  };

  // ------------------------------------------------------------------------
  // Protokoll und Status
  // ------------------------------------------------------------------------

  function protokoll(text, art) {
    art = art || 'info';
    const li = document.createElement('li');
    li.className = art;
    const zeit = document.createElement('time');
    zeit.textContent = new Date().toLocaleTimeString('de-DE');
    li.append(zeit, document.createTextNode(text));
    el.protokoll.prepend(li);
    while (el.protokoll.children.length > 80) el.protokoll.lastChild.remove();

    const ausgabe = art === 'fehler' ? console.error : art === 'warn' ? console.warn : console.log;
    ausgabe.call(console, '[Akkorderkennung] ' + text);
  }

  function setzeStatus(text, art) {
    el.status.textContent = text;
    el.statusBox.className = 'status' + (art ? ' ' + art : '');
  }

  // ------------------------------------------------------------------------
  // Essentia.js laden (mit Zeitlimit und Selbsttest)
  // ------------------------------------------------------------------------

  function ladeSkript(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const skript = document.createElement('script');
      skript.src = url;
      skript.async = false;
      const timer = setTimeout(function () {
        reject(new Error('Zeitüberschreitung beim Laden von ' + url));
      }, timeoutMs);
      skript.onload = function () { clearTimeout(timer); resolve(); };
      skript.onerror = function () {
        clearTimeout(timer);
        reject(new Error('Skript konnte nicht geladen werden: ' + url));
      };
      document.head.appendChild(skript);
    });
  }

  function mitZeitlimit(promise, ms, meldung) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error(meldung)); }, ms);
      })
    ]);
  }

  /**
   * Initialisiert das Emscripten-Modul. Das Ergebnis wird in ein Objekt
   * verpackt, weil das Modul selbst eine then()-Methode besitzt und ein
   * direktes resolve() sonst in einer Endlosschleife enden kann.
   */
  function initialisiereWasm() {
    return new Promise(function (resolve, reject) {
      try {
        /* global EssentiaWASM */
        const modul = typeof EssentiaWASM === 'function' ? EssentiaWASM() : EssentiaWASM;
        if (modul && typeof modul.then === 'function') {
          modul.then(function (fertig) { resolve({ modul: fertig }); });
        } else if (modul) {
          resolve({ modul: modul });
        } else {
          reject(new Error('EssentiaWASM lieferte kein Modul.'));
        }
      } catch (fehler) {
        reject(fehler);
      }
    });
  }

  async function ladeEssentia() {
    if (typeof WebAssembly !== 'object') {
      throw new Error('WebAssembly wird von diesem Browser nicht unterstützt.');
    }
    for (const url of ESSENTIA_URLS) {
      await ladeSkript(url, KONFIG.ladeTimeoutMs);
    }
    /* global Essentia */
    if (typeof EssentiaWASM === 'undefined' || typeof Essentia !== 'function') {
      throw new Error('Essentia.js-Module wurden nach dem Laden nicht gefunden.');
    }
    const ergebnis = await mitZeitlimit(
      initialisiereWasm(),
      KONFIG.ladeTimeoutMs,
      'Die WASM-Initialisierung hat zu lange gedauert.'
    );
    return new Essentia(ergebnis.modul);
  }

  /**
   * HPCP-Kette nach dem MTG-Standard. Gibt die 12 Rohwerte zurück
   * (Bin 0 = Referenzfrequenz, also A). Alle erzeugten WASM-Vektoren
   * werden anschließend freigegeben, damit kein Speicherleck entsteht.
   */
  function hpcpRoh(essentia, puffer, abtastrate) {
    const h = KONFIG.hpcp;
    const freigeben = [];
    try {
      const signal = essentia.arrayToVector(puffer);
      freigeben.push(signal);

      const fenster = essentia.Windowing(signal, true, puffer.length, h.fensterTyp);
      freigeben.push(fenster.frame);

      const spektrum = essentia.Spectrum(fenster.frame, puffer.length);
      freigeben.push(spektrum.spectrum);

      const spitzen = essentia.SpectralPeaks(
        spektrum.spectrum, 0, h.maxFrequenz, h.maxPeaks, h.minFrequenz, 'frequency', abtastrate
      );
      freigeben.push(spitzen.frequencies, spitzen.magnitudes);

      const weiss = essentia.SpectralWhitening(
        spektrum.spectrum, spitzen.frequencies, spitzen.magnitudes, h.maxFrequenz, abtastrate
      );
      freigeben.push(weiss.magnitudes);

      const hpcp = essentia.HPCP(
        spitzen.frequencies, weiss.magnitudes,
        true,            // bandPreset
        h.bandSplit,     // bandSplitFrequency
        h.harmonische,   // harmonics
        h.maxFrequenz,   // maxFrequency
        false,           // maxShifted
        h.minFrequenz,   // minFrequency
        true,            // nonLinear
        'unitMax',       // normalized
        h.referenz,      // referenceFrequency
        abtastrate,      // sampleRate
        h.groesse        // size
      );
      freigeben.push(hpcp.hpcp);

      return essentia.vectorToArray(hpcp.hpcp);
    } finally {
      for (const v of freigeben) {
        try { if (v && typeof v.delete === 'function') v.delete(); } catch (_) { /* ignorieren */ }
      }
    }
  }

  /** HPCP berechnen und so rotieren, dass Index 0 = C ist. */
  function essentiaChroma(puffer, abtastrate) {
    const roh = hpcpRoh(zustand.essentia, puffer, abtastrate);
    const chroma = new Float32Array(12);
    for (let i = 0; i < 12; i++) chroma[(i + zustand.hpcpVersatz) % 12] = roh[i];
    return chroma;
  }

  /**
   * Selbsttest: Ein synthetischer 440-Hz-Sinus muss in der Tonklasse A landen.
   * Aus dem Ergebnis wird der Versatz zwischen HPCP-Bin und Tonklasse bestimmt.
   */
  function selbsttest(essentia) {
    const abtastrate = 44100;
    const n = KONFIG.puffergroesse;
    const sinus = new Float32Array(n);
    for (let i = 0; i < n; i++) sinus[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / abtastrate);

    const roh = hpcpRoh(essentia, sinus, abtastrate);
    if (!roh || roh.length !== 12) throw new Error('HPCP lieferte keinen 12-dimensionalen Vektor.');

    let maxIndex = 0;
    for (let i = 1; i < 12; i++) if (roh[i] > roh[maxIndex]) maxIndex = i;
    if (!(roh[maxIndex] > 0)) throw new Error('HPCP lieferte beim Selbsttest nur Nullwerte.');

    zustand.hpcpVersatz = (9 - maxIndex + 12) % 12;
    if (maxIndex === 0) {
      protokoll('Selbsttest bestanden: 440-Hz-Sinus → Tonklasse A.', 'ok');
    } else {
      protokoll('Selbsttest: Maximum in HPCP-Bin ' + maxIndex + ' statt 0. Versatz wurde angepasst.', 'warn');
    }
  }

  // ------------------------------------------------------------------------
  // Wahl des Verfahrens (Essentia oder Fallback)
  // ------------------------------------------------------------------------

  function bestimmeVerfahren() {
    if (!zustand.laeuft && !zustand.startetGerade) return; // wird beim Start erneut aufgerufen
    const neu = zustand.essentia && !el.fallbackErzwingen.checked ? 'essentia' : 'fallback';
    if (neu === zustand.verfahren) return;
    zustand.verfahren = neu;
    el.verfahren.textContent = VERFAHREN_NAME[neu];

    if (neu === 'essentia') {
      protokoll('Verfahren: ' + VERFAHREN_NAME.essentia + '.', 'ok');
      setzeStatus((zustand.quellArt === 'datei' ? 'Dateianalyse' : 'Analyse') + ' läuft mit Essentia.js (HPCP).', 'ok');
    } else {
      const grund = el.fallbackErzwingen.checked ? 'manuell erzwungen' : 'Essentia.js nicht verfügbar';
      protokoll('Verfahren: ' + VERFAHREN_NAME.fallback + ' (' + grund + ').', 'warn');
      setzeStatus((zustand.quellArt === 'datei' ? 'Dateianalyse' : 'Analyse') + ' läuft mit FFT-Chroma (Fallback, ' + grund + ').', 'warn');
    }
  }

  function wechsleZuFallback(grund) {
    protokoll(grund, 'fehler');
    protokoll('Automatischer Wechsel auf den FFT-Fallback. Die Analyse läuft weiter.', 'warn');
    zustand.essentia = null;
    zustand.essentiaStatus = 'fehler';
    bestimmeVerfahren();
  }

  // ------------------------------------------------------------------------
  // Frame-Verarbeitung (wird alle 4096 Samples aufgerufen)
  // ------------------------------------------------------------------------

  function schlageVor(id, daten) {
    if (id === zustand.kandidatId) {
      zustand.kandidatZaehler++;
    } else {
      zustand.kandidatId = id;
      zustand.kandidatZaehler = 1;
    }
    if (zustand.anzeige.id === id) {
      zustand.anzeige.konfidenz = daten.konfidenz;
    } else if (zustand.kandidatZaehler >= KONFIG.stabilFrames) {
      zustand.anzeige = Object.assign({ id: id }, daten);
      zustand.anzeigeGeaendert = true;
    }
  }

  function istGueltig(chroma) {
    let max = 0;
    for (let i = 0; i < chroma.length; i++) {
      if (!isFinite(chroma[i])) return false;
      if (chroma[i] > max) max = chroma[i];
    }
    return max > 0;
  }

  function messeZeit(start) {
    const dauer = performance.now() - start;
    zustand.rechenzeit = zustand.rechenzeit ? 0.9 * zustand.rechenzeit + 0.1 * dauer : dauer;
  }

  function verarbeiteFrame(ereignis) {
    if (!zustand.laeuft) return;
    const start = performance.now();
    const puffer = ereignis.inputBuffer.getChannelData(0);
    const abtastrate = zustand.audioCtx.sampleRate;

    // Pegel (RMS in dBFS)
    let summe = 0;
    for (let i = 0; i < puffer.length; i++) summe += puffer[i] * puffer[i];
    const rms = Math.sqrt(summe / puffer.length);
    zustand.rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    zustand.frames++;

    // Stille: Chroma ausklingen lassen, keine Erkennung
    if (zustand.rmsDb < zustand.schwelleDb) {
      for (let i = 0; i < 12; i++) zustand.chroma[i] *= 0.7;
      zustand.kandidaten = [];
      schlageVor('stille', {});
      messeZeit(start);
      return;
    }

    // Merkmalsextraktion
    let roh = null;
    if (zustand.verfahren === 'essentia') {
      try {
        roh = essentiaChroma(puffer, abtastrate);
        if (!istGueltig(roh)) roh = null; // einzelner leerer Frame → Fallback nur für diesen Frame
      } catch (fehler) {
        wechsleZuFallback('Laufzeitfehler in Essentia.js: ' + (fehler && fehler.message ? fehler.message : fehler));
        roh = null;
      }
    }
    if (!roh) roh = zustand.fallback.berechne();

    // Exponentielle Glättung
    const a = KONFIG.glaettung;
    let max = 0;
    for (let i = 0; i < 12; i++) {
      zustand.chroma[i] = (1 - a) * zustand.chroma[i] + a * roh[i];
      if (zustand.chroma[i] > max) max = zustand.chroma[i];
    }

    if (max < 1e-6) {
      zustand.kandidaten = [];
      schlageVor('unklar', { konfidenz: 0 });
      messeZeit(start);
      return;
    }

    // Template-Matching
    const normiert = new Float32Array(12);
    for (let i = 0; i < 12; i++) normiert[i] = zustand.chroma[i] / max;
    const ergebnisse = Akkorde.erkenne(normiert, 3);
    zustand.kandidaten = ergebnisse;

    const bester = ergebnisse[0];
    if (!bester || bester.wert < KONFIG.minKonfidenz) {
      schlageVor('unklar', { konfidenz: bester ? bester.wert : 0 });
    } else {
      schlageVor(bester.vorlage.id, { vorlage: bester.vorlage, konfidenz: bester.wert });
    }
    messeZeit(start);
  }

  // ------------------------------------------------------------------------
  // Darstellung: Chroma-Rad
  // ------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const rad = { segmente: [], marker: [], labels: [] };
  const hpcpSaeulen = [];
  const hpcpZahlen = [];
  const hpcpTonnamen = [];

  /** Farbton je Tonklasse nach dem Quintenzirkel: verwandte Tonarten haben ähnliche Farben. */
  function farbe(tonklasse, helligkeit) {
    const farbton = ((tonklasse * 7) % 12) * 30;
    return 'hsl(' + farbton + ', 62%, ' + (helligkeit || 62) + '%)';
  }

  function punkt(r, winkel) {
    return [220 + r * Math.cos(winkel), 220 + r * Math.sin(winkel)];
  }

  function sektor(rInnen, rAussen, w0, w1) {
    const a = punkt(rAussen, w0), b = punkt(rAussen, w1);
    const c = punkt(rInnen, w1), d = punkt(rInnen, w0);
    return 'M' + a[0] + ' ' + a[1] +
      ' A' + rAussen + ' ' + rAussen + ' 0 0 1 ' + b[0] + ' ' + b[1] +
      ' L' + c[0] + ' ' + c[1] +
      ' A' + rInnen + ' ' + rInnen + ' 0 0 0 ' + d[0] + ' ' + d[1] + ' Z';
  }

  function bogen(r, w0, w1) {
    const a = punkt(r, w0), b = punkt(r, w1);
    return 'M' + a[0] + ' ' + a[1] + ' A' + r + ' ' + r + ' 0 0 1 ' + b[0] + ' ' + b[1];
  }

  function baueRad() {
    const grad = Math.PI / 180;
    const luecke = 0.012;
    for (let i = 0; i < 12; i++) {
      const mitte = (i * 30 - 90) * grad;          // C oben, im Uhrzeigersinn
      const w0 = mitte - 15 * grad + luecke;
      const w1 = mitte + 15 * grad - luecke;

      const segment = document.createElementNS(SVG_NS, 'path');
      segment.setAttribute('d', sektor(122, 172, w0, w1));
      segment.setAttribute('class', 'segment');
      segment.setAttribute('fill', farbe(i));
      segment.setAttribute('fill-opacity', '0.08');
      el.rad.appendChild(segment);
      rad.segmente.push(segment);

      const marker = document.createElementNS(SVG_NS, 'path');
      marker.setAttribute('d', bogen(182, w0 + 0.05, w1 - 0.05));
      marker.setAttribute('class', 'marker');
      el.rad.appendChild(marker);
      rad.marker.push(marker);

      const pos = punkt(202, mitte);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', pos[0]);
      label.setAttribute('y', pos[1]);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('class', 'ton-label');
      el.rad.appendChild(label);
      rad.labels.push(label);
    }
  }

  function baueHpcpSpalten() {
    for (let i = 0; i < 12; i++) {
      const spalte = document.createElement('div');
      spalte.className = 'hpcp-spalte';

      const zahlEl = document.createElement('span');
      zahlEl.textContent = '0';
      const saeule = document.createElement('div');
      saeule.className = 'hpcp-saeule';
      const fuellung = document.createElement('span');
      fuellung.style.background = farbe(i);
      saeule.appendChild(fuellung);
      const ton = document.createElement('span');
      ton.className = 'ton';

      spalte.append(zahlEl, saeule, ton);
      el.hpcpWerte.appendChild(spalte);
      hpcpSaeulen.push(fuellung);
      hpcpZahlen.push(zahlEl);
      hpcpTonnamen.push(ton);
    }
  }

  function beschrifteTonklassen() {
    const namen = Akkorde.NOTEN[zustand.notation];
    for (let i = 0; i < 12; i++) {
      rad.labels[i].textContent = namen[i];
      hpcpTonnamen[i].textContent = namen[i];
    }
  }

  function zeigeAkkord() {
    const a = zustand.anzeige;
    let symbol = '–';
    let name = '';
    let toene = [];
    let grundton = -1;

    switch (a.id) {
      case 'bereit': name = 'Bereit'; break;
      case 'hoert':  name = zustand.quellArt === 'datei' ? 'Datei wird analysiert …' : 'Höre zu …'; break;
      case 'stille': name = 'Stille. Spiel einen Ton oder Akkord.'; break;
      case 'unklar': symbol = '?'; name = 'Kein eindeutiger Akkord'; break;
      default: {
        const b = Akkorde.bezeichnung(a.vorlage, zustand.notation);
        symbol = b.symbol;
        name = b.langname;
        toene = a.vorlage.toene;
        grundton = a.vorlage.grundton;
      }
    }

    if (el.symbol.textContent !== symbol) {
      el.symbol.textContent = symbol;
      el.symbol.classList.remove('neu');
      void el.symbol.offsetWidth; // Animation neu starten
      el.symbol.classList.add('neu');
    }
    el.name.textContent = name;
    el.akkordBox.classList.toggle('leer', grundton < 0);

    for (let i = 0; i < 12; i++) {
      const istTon = toene.indexOf(i) >= 0;
      rad.marker[i].classList.toggle('akkordton', istTon);
      rad.marker[i].classList.toggle('grundton', i === grundton);
      rad.labels[i].classList.toggle('akkordton', istTon);
    }

    document.documentElement.style.setProperty(
      '--akzent', grundton >= 0 ? farbe(grundton, 66) : 'var(--messing)'
    );
  }

  // ------------------------------------------------------------------------
  // Darstellung: Monitor
  // ------------------------------------------------------------------------

  function aktualisiereMonitor() {
    el.frames.textContent = zustand.frames.toLocaleString('de-DE');

    if (zustand.audioCtx && zustand.rechenzeit) {
      const budget = KONFIG.puffergroesse / zustand.audioCtx.sampleRate * 1000;
      el.zeit.textContent = zahl(zustand.rechenzeit, 2) + ' ms (Budget ' + zahl(budget, 0) + ' ms)';
    } else {
      el.zeit.textContent = '–';
    }

    if (zustand.laeuft) {
      const db = zustand.rmsDb;
      el.pegel.textContent = isFinite(db) ? zahl(db, 1) + ' dBFS' : '−∞ dBFS';
      const anteil = isFinite(db) ? Math.min(1, Math.max(0, (db + 70) / 70)) : 0;
      el.pegelBalken.style.width = (anteil * 100).toFixed(1) + '%';
      el.pegelBalken.classList.toggle('laut', db > -3);
    } else {
      el.pegel.textContent = '–';
      el.pegelBalken.style.width = '0';
    }

    // Kandidaten
    el.kandidaten.replaceChildren();
    if (!zustand.kandidaten.length) {
      const li = document.createElement('li');
      li.className = 'platzhalter';
      li.textContent = zustand.laeuft ? 'Kein Signal über der Stille-Schwelle' : 'Noch keine Daten';
      el.kandidaten.appendChild(li);
    } else {
      for (const k of zustand.kandidaten) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'kname';
        const b = Akkorde.bezeichnung(k.vorlage, zustand.notation);
        name.textContent = b.kurz;
        name.title = b.langname;
        const balken = document.createElement('span');
        balken.className = 'balken';
        const fuellung = document.createElement('span');
        fuellung.style.width = (Math.max(0, k.wert) * 100).toFixed(1) + '%';
        balken.appendChild(fuellung);
        const wert = document.createElement('span');
        wert.className = 'kwert';
        wert.textContent = zahl(k.wert * 100, 0) + ' %';
        li.append(name, balken, wert);
        el.kandidaten.appendChild(li);
      }
    }

    for (let i = 0; i < 12; i++) {
      hpcpZahlen[i].textContent = Math.round(zustand.chroma[i] * 100);
    }
  }

  function zeichne(zeit) {
    for (let i = 0; i < 12; i++) {
      const v = Math.min(1, Math.max(0, zustand.chroma[i]));
      rad.segmente[i].setAttribute('fill-opacity', (0.08 + 0.92 * v).toFixed(3));
      hpcpSaeulen[i].style.height = (v * 100).toFixed(1) + '%';
    }
    if (zustand.anzeigeGeaendert) {
      zustand.anzeigeGeaendert = false;
      zeigeAkkord();
    }
    if (!zustand.laeuft || zeit - zustand.letzterMonitor >= KONFIG.monitorIntervallMs) {
      zustand.letzterMonitor = zeit;
      aktualisiereMonitor();
    }
    if (zustand.laeuft) zustand.rafId = requestAnimationFrame(zeichne);
  }

  // ------------------------------------------------------------------------
  // Start und Stopp
  // ------------------------------------------------------------------------

  function setzeKnoepfe(modus) {
    const art = zustand.quellArt;
    const aktiv = modus === 'aktiv';
    const laedt = modus === 'laedt';

    el.start.classList.toggle('aktiv', aktiv && art === 'mikrofon');
    el.startText.textContent =
      art === 'mikrofon' && aktiv ? 'Höre zu …' :
      art === 'mikrofon' && laedt ? 'Mikrofon wird angefragt …' :
      'Analyse starten';
    el.start.setAttribute('aria-pressed', String(aktiv && art === 'mikrofon'));
    el.start.disabled = modus !== 'bereit' || !zustand.mikrofonMoeglich;

    el.datei.classList.toggle('aktiv', aktiv && art === 'datei');
    el.dateiText.textContent =
      art === 'datei' && aktiv ? 'Analysiere Datei …' :
      art === 'datei' && laedt ? 'Datei wird geladen …' :
      'Audiodatei analysieren';
    el.datei.setAttribute('aria-pressed', String(aktiv && art === 'datei'));
    el.datei.disabled = modus !== 'bereit';

    el.stop.disabled = !aktiv;
  }

  function beschreibeFehler(fehler) {
    const name = fehler && fehler.name;
    if (zustand.quellArt === 'datei') {
      return 'Die Datei konnte nicht abgespielt werden. Verwende ein gängiges Format wie MP3, WAV, M4A oder OGG. (' +
        (fehler && fehler.message ? fehler.message : String(fehler)) + ')';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Mikrofonzugriff wurde verweigert. Erlaube den Zugriff in den Website-Einstellungen des Browsers und starte die Analyse erneut.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'Kein Mikrofon gefunden. Schließe ein Mikrofon an und starte die Analyse erneut.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'Das Mikrofon wird von einer anderen Anwendung verwendet. Beende diese Anwendung und starte erneut.';
    }
    return 'Start fehlgeschlagen: ' + (fehler && fehler.message ? fehler.message : String(fehler));
  }

  /** Größe einer Datei lesbar formatieren. */
  function dateiGroesse(bytes) {
    return bytes >= 1048576 ? zahl(bytes / 1048576, 1) + ' MB' : zahl(bytes / 1024, 0) + ' kB';
  }

  /**
   * Erzeugt ein Audio-Element für die gewählte Datei und wartet, bis der
   * Browser die Datei dekodieren kann. Pro AudioContext wird ein neues
   * Element benötigt, weil createMediaElementSource() ein Element dauerhaft
   * an einen Kontext bindet.
   */
  function erzeugePlayer(datei) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(datei);
      zustand.dateiUrl = url;
      const audio = new Audio();
      audio.controls = true;
      audio.preload = 'auto';
      audio.setAttribute('aria-label', 'Wiedergabe von ' + datei.name);
      const aufraeumen = function () {
        audio.removeEventListener('canplay', ok);
        audio.removeEventListener('error', fehler);
      };
      const ok = function () { aufraeumen(); resolve(audio); };
      const fehler = function () {
        aufraeumen();
        reject(new Error(audio.error ? 'Medienfehler ' + audio.error.code : 'Unbekannter Medienfehler'));
      };
      audio.addEventListener('canplay', ok);
      audio.addEventListener('error', fehler);
      audio.src = url;
    });
  }

  function starteMikrofon() {
    zustand.quellArt = 'mikrofon';
    return starteAnalyse(null);
  }

  function dateiGewaehlt() {
    const datei = el.dateiEingabe.files && el.dateiEingabe.files[0];
    el.dateiEingabe.value = ''; // dieselbe Datei kann erneut gewählt werden
    if (!datei) return;
    zustand.quellArt = 'datei';
    starteAnalyse(datei);
  }

  /**
   * Gemeinsamer Start für beide Quellen. Mikrofon und Datei durchlaufen
   * dieselbe Verarbeitungskette; nur der Quellknoten unterscheidet sich.
   * @param {File|null} datei  null = Mikrofon
   */
  async function starteAnalyse(datei) {
    if (zustand.laeuft || zustand.startetGerade) return;
    zustand.startetGerade = true;
    setzeKnoepfe('laedt');

    try {
      let stream = null;
      let audio = null;

      if (!datei) {
        setzeStatus('Mikrofonzugriff wird angefragt …');
        protokoll('Mikrofonzugriff wird angefragt.');
        // Automatische Signalverarbeitung abschalten: sie verfälscht Musiksignale
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false
        });
        zustand.stream = stream;
        const spur = stream.getAudioTracks()[0];
        protokoll('Mikrofonzugriff erteilt: ' + (spur && spur.label ? spur.label : 'Standardgerät') + '.', 'ok');
        if (spur) {
          spur.addEventListener('ended', function () {
            protokoll('Das Mikrofon wurde getrennt.', 'warn');
            stoppen();
          });
        }
      } else {
        setzeStatus('Datei wird geladen …');
        protokoll('Datei gewählt: ' + datei.name + ' (' + dateiGroesse(datei.size) + ').');
        audio = await erzeugePlayer(datei);
        zustand.audioEl = audio;
        el.dateiName.textContent = datei.name;
        el.player.replaceChildren(audio);
        el.playerBox.hidden = false;
        if (isFinite(audio.duration)) {
          protokoll('Datei dekodierbar, Dauer ' + zahl(audio.duration, 1) + ' s.', 'ok');
        }
      }

      const Kontext = window.AudioContext || window.webkitAudioContext;
      const ctx = new Kontext();
      zustand.audioCtx = ctx;
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_) { /* wird beim Abspielen erneut versucht */ }
      }
      el.rate.textContent = ctx.sampleRate.toLocaleString('de-DE') + ' Hz';
      protokoll('AudioContext geöffnet: ' + ctx.sampleRate + ' Hz, Puffer ' + KONFIG.puffergroesse + ' Samples.');

      if (zustand.essentiaStatus === 'laedt') setzeStatus('Warte auf Essentia.js …');
      await zustand.essentiaPromise;

      // Quellknoten
      if (stream) {
        zustand.quelle = ctx.createMediaStreamSource(stream);
        el.quelle.textContent = 'Mikrofon';
      } else {
        zustand.quelle = ctx.createMediaElementSource(audio);
        zustand.quelle.connect(ctx.destination); // Datei bleibt hörbar
        el.quelle.textContent = 'Datei: ' + datei.name;
      }

      // Analyse-Knoten
      zustand.analyser = ctx.createAnalyser();
      zustand.analyser.fftSize = KONFIG.fallback.fftGroesse;
      zustand.analyser.smoothingTimeConstant = 0;
      zustand.prozessor = ctx.createScriptProcessor(KONFIG.puffergroesse, 1, 1);
      zustand.senke = ctx.createGain();
      zustand.senke.gain.value = 0; // stumm: kein Rückkopplungsrisiko

      zustand.fallback = new FallbackChroma(zustand.analyser, ctx.sampleRate, {
        minFrequenz: KONFIG.fallback.minFrequenz,
        maxFrequenz: KONFIG.fallback.maxFrequenz,
        dynamikDb: KONFIG.fallback.dynamikDb,
        referenz: KONFIG.hpcp.referenz
      });

      // Messwerte zurücksetzen
      zustand.chroma.fill(0);
      zustand.frames = 0;
      zustand.rechenzeit = 0;
      zustand.kandidaten = [];
      zustand.kandidatId = null;
      zustand.kandidatZaehler = 0;
      zustand.verfahren = null;
      bestimmeVerfahren();

      // Graph verbinden. Der ScriptProcessorNode muss mit dem Ziel verbunden
      // sein, sonst ruft Chrome onaudioprocess nicht auf.
      zustand.prozessor.onaudioprocess = verarbeiteFrame;
      zustand.quelle.connect(zustand.analyser);
      zustand.quelle.connect(zustand.prozessor);
      zustand.prozessor.connect(zustand.senke);
      zustand.senke.connect(ctx.destination);

      zustand.laeuft = true;
      zustand.anzeige = { id: 'hoert' };
      zustand.anzeigeGeaendert = true;
      setzeKnoepfe('aktiv');
      zustand.rafId = requestAnimationFrame(zeichne);

      if (audio) {
        audio.addEventListener('play', function () {
          // Klick auf „Play“ ist eine Nutzeraktion: AudioContext sicher fortsetzen
          if (ctx.state === 'suspended') ctx.resume();
          protokoll('Wiedergabe läuft.');
        });
        audio.addEventListener('pause', function () {
          if (zustand.laeuft && !audio.ended) protokoll('Wiedergabe pausiert.');
        });
        audio.addEventListener('ended', function () {
          protokoll('Ende der Datei erreicht.', 'ok');
          stoppen();
        });
        try {
          await audio.play();
        } catch (_) {
          protokoll('Automatische Wiedergabe blockiert. Starte die Wiedergabe im Player.', 'warn');
          setzeStatus('Drücke im Player auf Play, um die Analyse der Datei zu starten.', 'warn');
        }
        protokoll('Analyse der Datei gestartet.', 'ok');
      } else {
        protokoll('Analyse gestartet.', 'ok');
      }
    } catch (fehler) {
      const meldung = beschreibeFehler(fehler);
      protokoll(meldung, 'fehler');
      await stoppen(true);
      setzeStatus(meldung, 'fehler');
    } finally {
      zustand.startetGerade = false;
    }
  }

  async function stoppen(still) {
    const warAktiv = zustand.laeuft;
    const warDatei = zustand.quellArt === 'datei';
    zustand.laeuft = false;
    if (zustand.rafId) cancelAnimationFrame(zustand.rafId);
    zustand.rafId = null;

    if (zustand.prozessor) zustand.prozessor.onaudioprocess = null;
    for (const knoten of [zustand.quelle, zustand.analyser, zustand.prozessor, zustand.senke]) {
      if (knoten) { try { knoten.disconnect(); } catch (_) { /* bereits getrennt */ } }
    }
    // Alle Spuren beenden: erst dadurch erlischt die Mikrofon-Anzeige des Systems
    if (zustand.stream) zustand.stream.getTracks().forEach(function (spur) { spur.stop(); });
    // Datei-Wiedergabe beenden und Speicher freigeben
    if (zustand.audioEl) {
      try { zustand.audioEl.pause(); } catch (_) { /* ignorieren */ }
      zustand.audioEl.removeAttribute('src');
      try { zustand.audioEl.load(); } catch (_) { /* ignorieren */ }
    }
    if (zustand.dateiUrl) URL.revokeObjectURL(zustand.dateiUrl);
    el.player.replaceChildren();
    el.playerBox.hidden = true;

    if (zustand.audioCtx && zustand.audioCtx.state !== 'closed') {
      try { await zustand.audioCtx.close(); } catch (_) { /* ignorieren */ }
    }

    Object.assign(zustand, {
      audioCtx: null, stream: null, quelle: null, analyser: null,
      prozessor: null, senke: null, fallback: null, verfahren: null,
      audioEl: null, dateiUrl: null,
      rmsDb: -Infinity, kandidaten: [], kandidatId: null, kandidatZaehler: 0,
      anzeige: { id: 'bereit' }, anzeigeGeaendert: true
    });
    zustand.chroma.fill(0);

    el.quelle.textContent = '–';
    el.verfahren.textContent = '–';
    el.rate.textContent = '–';
    setzeKnoepfe('bereit');
    zeichne(performance.now());

    if (warAktiv && !still) {
      if (warDatei) {
        protokoll('Analyse der Datei beendet. AudioContext wurde geschlossen.', 'ok');
        setzeStatus('Gestoppt. Wähle eine neue Datei oder starte das Mikrofon.');
      } else {
        protokoll('Analyse gestoppt. Mikrofon und AudioContext wurden freigegeben.', 'ok');
        setzeStatus('Gestoppt. Das Mikrofon ist freigegeben.');
      }
    }
  }

  // ------------------------------------------------------------------------
  // Initialisierung
  // ------------------------------------------------------------------------

  function init() {
    baueRad();
    baueHpcpSpalten();
    beschrifteTonklassen();
    zeichne(performance.now());
    protokoll('Anwendung initialisiert.');

    el.start.addEventListener('click', starteMikrofon);
    el.datei.addEventListener('click', function () { el.dateiEingabe.click(); });
    el.dateiEingabe.addEventListener('change', dateiGewaehlt);
    el.stop.addEventListener('click', function () { stoppen(); });

    el.notation.addEventListener('change', function () {
      zustand.notation = el.notation.value;
      beschrifteTonklassen();
      zustand.anzeigeGeaendert = true;
      zeichne(performance.now());
    });

    el.schwelle.addEventListener('input', function () {
      zustand.schwelleDb = Number(el.schwelle.value);
      el.schwelleAusgabe.textContent = String(zustand.schwelleDb).replace('-', '−') + ' dBFS';
    });

    el.fallbackErzwingen.addEventListener('change', function () {
      if (!el.fallbackErzwingen.checked && !zustand.essentia) {
        protokoll('Essentia.js ist nicht verfügbar. Der Fallback bleibt aktiv.', 'warn');
      }
      bestimmeVerfahren();
    });

    window.addEventListener('pagehide', function () { stoppen(true); });

    const sichererKontext = window.isSecureContext &&
      navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (!sichererKontext) {
      zustand.mikrofonMoeglich = false;
      el.start.disabled = true;
      const meldung = 'Mikrofonzugriff ist nur über HTTPS oder localhost möglich. Die Analyse von Audiodateien funktioniert trotzdem.';
      setzeStatus(meldung, 'fehler');
      protokoll(meldung, 'fehler');
    }

    protokoll('Lade Essentia.js ' + KONFIG.essentiaVersion + ' (WebAssembly) …');
    zustand.essentiaPromise = ladeEssentia()
      .then(function (essentia) {
        selbsttest(essentia);
        zustand.essentia = essentia;
        zustand.essentiaStatus = 'bereit';
        protokoll('Essentia.js ' + (essentia.version || '') + ' geladen.', 'ok');
        if (sichererKontext && !zustand.laeuft) setzeStatus('Bereit. Essentia.js ist geladen.', 'ok');
        return essentia;
      })
      .catch(function (fehler) {
        zustand.essentia = null;
        zustand.essentiaStatus = 'fehler';
        protokoll('Essentia.js nicht verfügbar: ' + (fehler && fehler.message ? fehler.message : fehler), 'warn');
        protokoll('Die Analyse verwendet den FFT-Fallback (AnalyserNode).', 'warn');
        if (sichererKontext && !zustand.laeuft) {
          setzeStatus('Bereit. Essentia.js ist nicht verfügbar, der FFT-Fallback wird verwendet.', 'warn');
        }
        return null;
      });
  }

  init();
})();
