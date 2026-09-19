/* ==========================================================================
   chords.js – Akkordvorlagen und Template-Matching
   --------------------------------------------------------------------------
   Ein Chroma-Vektor (12 Werte, Index 0 = C … Index 11 = B/H) wird mit
   binären Vorlagen für 12 Grundtöne × 5 Typen verglichen:
     Dur, Moll, vermindert, übermäßig und Einzelton (60 Vorlagen).
   Ähnlichkeitsmaß ist die Kosinus-Ähnlichkeit (0 … 1).
   ========================================================================== */

(function (global) {
  'use strict';

  /** Notennamen der zwölf Tonklassen, beginnend bei C. */
  const NOTEN = {
    international: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
    deutsch:       ['C', 'Cis', 'D', 'Dis', 'E', 'F', 'Fis', 'G', 'Gis', 'A', 'B', 'H']
  };

  /** Akkordtypen als Intervalle in Halbtönen über dem Grundton. */
  const TYPEN = [
    { id: 'dur',          intervalle: [0, 4, 7], symbol: '',  name: 'Dur' },
    { id: 'moll',         intervalle: [0, 3, 7], symbol: 'm', name: 'Moll' },
    { id: 'vermindert',   intervalle: [0, 3, 6], symbol: '°', name: 'vermindert' },
    { id: 'uebermaessig', intervalle: [0, 4, 8], symbol: '+', name: 'übermäßig' },
    { id: 'einzelton',    intervalle: [0],       symbol: '',  name: 'Einzelton' }
  ];

  /**
   * Kleiner Bonus für die Energie des Grundtons. Er entscheidet nur bei
   * exakten Gleichständen, z. B. bei übermäßigen Dreiklängen, die
   * symmetrisch sind (C+ = E+ = G♯+ enthalten dieselben Töne).
   */
  const GRUNDTON_BONUS = 1e-3;

  /** Erzeugt alle 60 Vorlagen mit auf Länge 1 normierten Vektoren. */
  function erzeugeVorlagen() {
    const vorlagen = [];
    for (const typ of TYPEN) {
      for (let grundton = 0; grundton < 12; grundton++) {
        const toene = typ.intervalle.map(function (i) { return (grundton + i) % 12; });
        const vektor = new Float32Array(12);
        const wert = 1 / Math.sqrt(toene.length);
        for (const t of toene) vektor[t] = wert;
        vorlagen.push({
          id: typ.id + '-' + grundton,
          grundton: grundton,
          typ: typ,
          toene: toene,
          vektor: vektor
        });
      }
    }
    return vorlagen;
  }

  const VORLAGEN = erzeugeVorlagen();

  /**
   * Vergleicht einen Chroma-Vektor mit allen Vorlagen.
   * @param {Float32Array|number[]} chroma  12 Werte, Index 0 = C
   * @param {number} anzahl                 Anzahl der zurückgegebenen Kandidaten
   * @returns {{vorlage: object, wert: number}[]} absteigend sortiert
   */
  function erkenne(chroma, anzahl) {
    anzahl = anzahl || 3;
    let betrag = 0;
    for (let i = 0; i < 12; i++) betrag += chroma[i] * chroma[i];
    betrag = Math.sqrt(betrag);
    if (betrag === 0) return [];

    const ergebnisse = VORLAGEN.map(function (v) {
      let skalar = 0;
      for (const t of v.toene) skalar += chroma[t] * v.vektor[t];
      const kosinus = skalar / betrag;
      return {
        vorlage: v,
        wert: kosinus,
        sortierwert: kosinus + GRUNDTON_BONUS * (chroma[v.grundton] / betrag)
      };
    });

    ergebnisse.sort(function (a, b) { return b.sortierwert - a.sortierwert; });
    return ergebnisse.slice(0, anzahl);
  }

  /**
   * Liefert das Kurzsymbol (z. B. „Am“, „F♯°“) und einen deutschen
   * Langnamen (z. B. „a-Moll“). Der Langname verwendet immer die deutsche
   * Notenschrift (H statt B), das Symbol die gewählte Notenschrift.
   */
  function bezeichnung(vorlage, notation) {
    const namen = NOTEN[notation] || NOTEN.international;
    const de = NOTEN.deutsch[vorlage.grundton];
    const symbol = namen[vorlage.grundton] + vorlage.typ.symbol;
    let langname;
    switch (vorlage.typ.id) {
      case 'dur':          langname = de + '-Dur'; break;
      case 'moll':         langname = de.toLowerCase() + '-Moll'; break;
      case 'vermindert':   langname = 'Verminderter Dreiklang auf ' + de; break;
      case 'uebermaessig': langname = 'Übermäßiger Dreiklang auf ' + de; break;
      default:             langname = 'Einzelton ' + de;
    }
    // Kurzform für die Kandidatenliste: Einzeltöne sonst nicht von Dur unterscheidbar
    const kurz = vorlage.typ.id === 'einzelton' ? 'Ton ' + namen[vorlage.grundton] : symbol;
    return { symbol: symbol, kurz: kurz, langname: langname };
  }

  global.Akkorde = {
    NOTEN: NOTEN,
    TYPEN: TYPEN,
    VORLAGEN: VORLAGEN,
    erkenne: erkenne,
    bezeichnung: bezeichnung
  };
})(typeof window !== 'undefined' ? window : globalThis);
