const canvas = document.querySelector("#gameCanvas");
const ctx = canvas.getContext("2d");
let viewWidth = 1280;
let viewHeight = 720;
let devicePixelRatioUsed = 1;

const midiStatus = document.querySelector("#midiStatus");
const permissionOverlay = document.querySelector("#permissionOverlay");
const connectButton = document.querySelector("#connectButton");
const inputSelect = document.querySelector("#inputSelect");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const panicButton = document.querySelector("#panicButton");
const difficultySelect = document.querySelector("#difficultySelect");
const whiteKeysOnlyInput = document.querySelector("#whiteKeysOnly");
const activeNotesEl = document.querySelector("#activeNotes");
const eventLog = document.querySelector("#eventLog");
const scoreEl = document.querySelector("#score");
const streakEl = document.querySelector("#streak");
const accuracyEl = document.querySelector("#accuracy");
const lowNoteInput = document.querySelector("#lowNote");
const highNoteInput = document.querySelector("#highNote");
const speedInput = document.querySelector("#speed");
const volumeInput = document.querySelector("#volume");
const midiFileInput = document.querySelector("#midiFileInput");

const activeNotes = new Map();
const playingVoices = new Map();
const fallingNotes = [];
const keyFlashes = [];
let midiAccess = null;
let selectedInput = null;
let audioContext = null;
let masterGain = null;
let animationFrame = 0;
let lastFrame = performance.now();
let gameRunning = false;
let nextSpawnAt = 0;
let roundStartAt = 0;
let songNoteIndex = 0;
let importedSong = null;
let backingSource = null;
let score = 0;
let streak = 0;
let hits = 0;
let misses = 0;
let recentJudgements = [];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEY_PITCHES = new Set([1, 3, 6, 8, 10]);

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const nextWidth = Math.max(320, Math.round(rect.width));
  const nextHeight = Math.max(220, Math.round(rect.height));
  const nextRatio = Math.max(1, window.devicePixelRatio || 1);

  if (nextWidth === viewWidth && nextHeight === viewHeight && nextRatio === devicePixelRatioUsed) {
    return;
  }

  viewWidth = nextWidth;
  viewHeight = nextHeight;
  devicePixelRatioUsed = nextRatio;
  canvas.width = Math.round(viewWidth * devicePixelRatioUsed);
  canvas.height = Math.round(viewHeight * devicePixelRatioUsed);
  ctx.setTransform(devicePixelRatioUsed, 0, 0, devicePixelRatioUsed, 0, 0);
}

function noteName(note) {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

function noteFrequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function getVolume() {
  return Number(volumeInput.value) / 100;
}

function clampMidiNote(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, Math.min(127, parsed));
}

function getRange() {
  if (difficultySelect.value === "easy") {
    return { low: 60, high: 72 };
  }

  if (difficultySelect.value === "middle") {
    return { low: 48, high: 72 };
  }

  const low = clampMidiNote(lowNoteInput.value, 36);
  const high = clampMidiNote(highNoteInput.value, 84);
  return low <= high ? { low, high } : { low: high, high: low };
}

function syncRangeInputs() {
  const { low, high } = getRange();
  lowNoteInput.value = low;
  highNoteInput.value = high;
  const custom = difficultySelect.value === "full";
  lowNoteInput.disabled = !custom;
  highNoteInput.disabled = !custom;
}

function logEvent(message, note) {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.innerHTML = note == null ? `<strong>${time}</strong> ${message}` : `<strong>${time}</strong> ${message} ${note} (${noteName(note)})`;
  eventLog.prepend(item);
  while (eventLog.children.length > 40) {
    eventLog.lastElementChild.remove();
  }
}

function setStatus(message) {
  midiStatus.textContent = message;
}

async function ensureAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    logEvent("Web Audio is unavailable in this browser");
    return false;
  }

  if (!audioContext) {
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    masterGain.gain.value = getVolume() * 0.45;
    masterGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return audioContext.state === "running";
}

function updateMasterGain() {
  if (!masterGain || !audioContext) return;
  masterGain.gain.setTargetAtTime(getVolume() * 0.45, audioContext.currentTime, 0.02);
}

function stopNote(note) {
  const voice = playingVoices.get(note);
  if (!voice || !audioContext) return;

  const now = audioContext.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0.0001, now, 0.035);
  voice.oscillator.stop(now + 0.18);
  playingVoices.delete(note);
}

function stopAllNotes() {
  for (const note of playingVoices.keys()) {
    stopNote(note);
  }
}

function stopBackingTrack() {
  if (!backingSource) return;

  try {
    backingSource.stop();
  } catch {
    // The source may already have ended.
  }

  backingSource.disconnect();
  backingSource = null;
}

function startBackingTrack(delaySeconds) {
  stopBackingTrack();
  if (!audioContext || !masterGain || !importedSong?.audioBuffer) return;

  backingSource = audioContext.createBufferSource();
  backingSource.buffer = importedSong.audioBuffer;
  backingSource.connect(masterGain);
  backingSource.onended = () => {
    backingSource = null;
  };
  backingSource.start(audioContext.currentTime + delaySeconds);
}

async function playNote(note, velocity) {
  const audioReady = await ensureAudio();
  if (!audioReady || !audioContext || !masterGain) return;

  stopNote(note);

  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  const velocityGain = Math.max(0.12, velocity / 127);

  oscillator.type = "triangle";
  oscillator.frequency.value = noteFrequency(note);
  filter.type = "lowpass";
  filter.frequency.value = 3600;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18 * velocityGain, now + 0.012);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  oscillator.start(now);

  playingVoices.set(note, { oscillator, gain });
}

function updateLiveNotes() {
  activeNotesEl.innerHTML = "";
  if (!activeNotes.size) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "No keys held";
    activeNotesEl.append(empty);
    return;
  }

  [...activeNotes.keys()].sort((a, b) => a - b).forEach((note) => {
    const pill = document.createElement("div");
    pill.className = "note-pill";
    pill.textContent = note;
    pill.title = noteName(note);
    activeNotesEl.append(pill);
  });
}

function refreshScoreboard() {
  scoreEl.textContent = score;
  streakEl.textContent = streak;
  const attempts = hits + misses;
  accuracyEl.textContent = attempts ? `${Math.round((hits / attempts) * 100)}%` : "--";
}

function resetGame() {
  fallingNotes.length = 0;
  recentJudgements = [];
  score = 0;
  streak = 0;
  hits = 0;
  misses = 0;
  nextSpawnAt = performance.now() + 900;
  roundStartAt = 0;
  songNoteIndex = 0;
  refreshScoreboard();
}

function isBlackKey(note) {
  return BLACK_KEY_PITCHES.has(note % 12);
}

function whiteKeysOnly() {
  return whiteKeysOnlyInput.checked;
}

function getPlayableNotes() {
  const { low, high } = getRange();
  const notes = [];

  for (let note = low; note <= high; note += 1) {
    if (!whiteKeysOnly() || !isBlackKey(note)) {
      notes.push(note);
    }
  }

  return notes.length ? notes : [low];
}

function nearestPlayableNote(note) {
  const playable = getPlayableNotes();
  let best = playable[0];
  let bestDistance = Math.abs(note - best);

  for (const candidate of playable) {
    const distance = Math.abs(note - candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function getKeyboardLayout() {
  const { low, high } = getRange();
  const notes = [];
  const whiteNotes = [];

  for (let note = low; note <= high; note += 1) {
    notes.push(note);
    if (!isBlackKey(note)) {
      whiteNotes.push(note);
    }
  }

  const sideMargin = 28;
  const whiteHeight = Math.max(92, Math.min(150, viewHeight * 0.28));
  const keyboardTop = viewHeight - whiteHeight - 18;
  const blackHeight = whiteHeight * 0.62;
  const whiteWidth = (viewWidth - sideMargin * 2) / Math.max(1, whiteNotes.length);
  const blackWidth = whiteWidth * 0.62;
  const whiteIndexByNote = new Map(whiteNotes.map((note, index) => [note, index]));
  const keys = new Map();

  for (const note of whiteNotes) {
    const index = whiteIndexByNote.get(note);
    keys.set(note, {
      note,
      kind: "white",
      x: sideMargin + index * whiteWidth,
      y: keyboardTop,
      width: whiteWidth,
      height: whiteHeight,
      centerX: sideMargin + index * whiteWidth + whiteWidth / 2,
    });
  }

  for (const note of notes) {
    if (!isBlackKey(note)) continue;
    let previousWhite = note - 1;
    while (previousWhite >= low && isBlackKey(previousWhite)) previousWhite -= 1;

    let nextWhite = note + 1;
    while (nextWhite <= high && isBlackKey(nextWhite)) nextWhite += 1;

    const previousKey = keys.get(previousWhite);
    const nextKey = keys.get(nextWhite);
    const centerX = previousKey && nextKey ? (previousKey.centerX + nextKey.centerX) / 2 : (previousKey?.x ?? sideMargin) + whiteWidth;

    keys.set(note, {
      note,
      kind: "black",
      x: centerX - blackWidth / 2,
      y: keyboardTop,
      width: blackWidth,
      height: blackHeight,
      centerX,
    });
  }

  return {
    low,
    high,
    keys,
    whiteKeys: whiteNotes.map((note) => keys.get(note)),
    blackKeys: notes.filter(isBlackKey).map((note) => keys.get(note)).filter(Boolean),
    keyboardTop,
    keyboardBottom: keyboardTop + whiteHeight,
  };
}

function noteToX(note) {
  return getKeyboardLayout().keys.get(note)?.centerX ?? viewWidth / 2;
}

function drawCenteredLines(lines, x, y, lineHeight) {
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight);
  });
}

function wrapText(text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(nextLine).width <= maxWidth || !line) {
      line = nextLine;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function randomTargetNote() {
  const playable = getPlayableNotes();
  return playable[Math.floor(Math.random() * playable.length)];
}

function fitNoteToRange(note) {
  const { low, high } = getRange();
  let fitted = note;

  while (fitted < low) fitted += 12;
  while (fitted > high) fitted -= 12;

  if (fitted < low || fitted > high) {
    fitted = Math.min(high, Math.max(low, fitted));
  }

  return whiteKeysOnly() ? nearestPlayableNote(fitted) : fitted;
}

function rangeNoteFromUnit(unit) {
  const playable = getPlayableNotes();
  const index = Math.round(Math.max(0, Math.min(1, unit)) * (playable.length - 1));
  return playable[index];
}

function spawnNote(note = randomTargetNote(), sourceNote = note) {
  fallingNotes.push({
    note,
    sourceNote,
    y: -42,
    hit: false,
    missed: false,
    id: crypto.randomUUID(),
  });
}

function recordJudgement(label, color) {
  recentJudgements.unshift({ label, color, createdAt: performance.now() });
  recentJudgements = recentJudgements.slice(0, 5);
}

function triggerKeyFlash(note, color = "#39d98a", strength = 1) {
  keyFlashes.push({
    note,
    color,
    strength,
    createdAt: performance.now(),
  });

  while (keyFlashes.length > 32) {
    keyFlashes.shift();
  }
}

function readText(data, offset, length) {
  return String.fromCharCode(...data.slice(offset, offset + length));
}

function readUint16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data, offset) {
  return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
}

function readVarLength(data, state) {
  let value = 0;
  let byte = 0;

  do {
    byte = data[state.offset];
    state.offset += 1;
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);

  return value;
}

function eventDataLength(status) {
  const type = status & 0xf0;
  return type === 0xc0 || type === 0xd0 ? 1 : 2;
}

function tickToMs(tick, tempoMap, ticksPerQuarter) {
  let ms = 0;
  let previousTick = 0;
  let tempo = 500000;

  for (const change of tempoMap) {
    if (change.tick > tick) break;
    ms += ((change.tick - previousTick) * tempo) / ticksPerQuarter / 1000;
    previousTick = change.tick;
    tempo = change.tempo;
  }

  ms += ((tick - previousTick) * tempo) / ticksPerQuarter / 1000;
  return ms;
}

function parseMidiFile(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  let offset = 0;

  if (readText(data, offset, 4) !== "MThd") {
    throw new Error("Not a standard MIDI file");
  }

  offset += 4;
  const headerLength = readUint32(data, offset);
  offset += 4;
  const format = readUint16(data, offset);
  const trackCount = readUint16(data, offset + 2);
  const ticksPerQuarter = readUint16(data, offset + 4);
  offset += headerLength;

  if (format > 2 || ticksPerQuarter & 0x8000) {
    throw new Error("Unsupported MIDI timing format");
  }

  const tempoEvents = [{ tick: 0, tempo: 500000 }];
  const noteEvents = [];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (readText(data, offset, 4) !== "MTrk") break;
    offset += 4;
    const trackEnd = offset + readUint32(data, offset);
    offset += 4;

    const state = { offset };
    let tick = 0;
    let runningStatus = 0;

    while (state.offset < trackEnd) {
      tick += readVarLength(data, state);
      let status = data[state.offset];

      if (status & 0x80) {
        state.offset += 1;
        runningStatus = status;
      } else {
        status = runningStatus;
      }

      if (status === 0xff) {
        const metaType = data[state.offset];
        state.offset += 1;
        const length = readVarLength(data, state);
        if (metaType === 0x51 && length === 3) {
          const tempo = (data[state.offset] << 16) | (data[state.offset + 1] << 8) | data[state.offset + 2];
          tempoEvents.push({ tick, tempo });
        }
        state.offset += length;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        state.offset += readVarLength(data, state);
        continue;
      }

      const length = eventDataLength(status);
      const first = data[state.offset];
      const second = length === 2 ? data[state.offset + 1] : 0;
      state.offset += length;

      if ((status & 0xf0) === 0x90 && second > 0) {
        noteEvents.push({ tick, note: first, velocity: second });
      }
    }

    offset = trackEnd;
  }

  const tempoMap = tempoEvents.sort((a, b) => a.tick - b.tick);
  const notes = noteEvents
    .map((event) => ({
      note: event.note,
      timeMs: tickToMs(event.tick, tempoMap, ticksPerQuarter),
      velocity: event.velocity,
    }))
    .sort((a, b) => a.timeMs - b.timeMs);

  if (!notes.length) {
    throw new Error("No playable notes found in that MIDI file");
  }

  const firstTime = notes[0].timeMs;
  return notes.map((event) => ({
    ...event,
    timeMs: Math.max(0, event.timeMs - firstTime),
  }));
}

async function importMidiSong(file) {
  if (!file) return;

  try {
    const notes = parseMidiFile(await file.arrayBuffer()).slice(0, 600);
    importedSong = {
      name: file.name,
      notes,
      type: "midi",
    };
    setStatus(`Loaded ${file.name}: ${notes.length} notes. Start Round will use the song.`);
    logEvent(`loaded song ${file.name} (${notes.length} notes)`);
  } catch (error) {
    importedSong = null;
    midiFileInput.value = "";
    setStatus(`Could not load MIDI: ${error.message}`);
    logEvent(`MIDI import failed: ${error.message}`);
  }
}

function analyzeAudioBuffer(buffer) {
  const channel = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const frameSize = Math.max(1024, Math.round(sampleRate * 0.045));
  const hopSize = Math.max(512, Math.round(sampleRate * 0.025));
  const frames = [];
  let previousEnergy = 0;

  for (let start = 0; start + frameSize < channel.length; start += hopSize) {
    let energy = 0;
    let zeroCrossings = 0;
    let previousSample = channel[start];

    for (let i = 0; i < frameSize; i += 1) {
      const sample = channel[start + i];
      energy += sample * sample;
      if ((sample >= 0 && previousSample < 0) || (sample < 0 && previousSample >= 0)) {
        zeroCrossings += 1;
      }
      previousSample = sample;
    }

    energy = Math.sqrt(energy / frameSize);
    const flux = Math.max(0, energy - previousEnergy);
    previousEnergy = energy;
    frames.push({
      timeMs: (start / sampleRate) * 1000,
      energy,
      flux,
      brightness: zeroCrossings / frameSize,
    });
  }

  if (!frames.length) {
    throw new Error("Audio file is too short to analyze");
  }

  const averageFlux = frames.reduce((sum, frame) => sum + frame.flux, 0) / frames.length;
  const averageEnergy = frames.reduce((sum, frame) => sum + frame.energy, 0) / frames.length;
  const notes = [];
  let lastNoteAt = -Infinity;

  for (let i = 1; i < frames.length - 1; i += 1) {
    const frame = frames[i];
    const isPeak = frame.flux > frames[i - 1].flux && frame.flux >= frames[i + 1].flux;
    const enoughSpace = frame.timeMs - lastNoteAt >= 230;
    const strongEnough = frame.flux > averageFlux * 1.45 && frame.energy > averageEnergy * 0.65;

    if (isPeak && enoughSpace && strongEnough) {
      const detectedNote = estimatePitchMidi(channel, sampleRate, frame.timeMs) ?? rangeNoteFromUnit(Math.min(1, frame.brightness * 14));
      notes.push({
        note: detectedNote,
        sourceNote: detectedNote,
        timeMs: frame.timeMs,
        velocity: Math.round(Math.min(127, 55 + frame.energy * 420)),
      });
      lastNoteAt = frame.timeMs;
    }
  }

  if (!notes.length) {
    throw new Error("Could not detect enough note moments in that audio file");
  }

  return notes.slice(0, 700);
}

function estimatePitchMidi(channel, sampleRate, timeMs) {
  const windowSize = Math.min(4096, channel.length);
  const center = Math.round((timeMs / 1000) * sampleRate);
  const start = Math.max(0, Math.min(channel.length - windowSize, center - Math.floor(windowSize / 2)));
  const minLag = Math.floor(sampleRate / 1000);
  const maxLag = Math.min(Math.floor(sampleRate / 80), Math.floor(windowSize / 2));
  let energy = 0;

  for (let i = 0; i < windowSize; i += 1) {
    const sample = channel[start + i];
    energy += sample * sample;
  }

  if (energy < 0.001) return null;

  let bestLag = 0;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    for (let i = 0; i < windowSize - lag; i += 1) {
      correlation += channel[start + i] * channel[start + i + lag];
    }
    correlation /= energy;

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (!bestLag || bestCorrelation < 0.22) return null;

  const frequency = sampleRate / bestLag;
  if (frequency < 40 || frequency > 1600) return null;

  return Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(frequency / 440))));
}

async function importAudioSong(file) {
  await ensureAudio();
  if (!audioContext) {
    throw new Error("Web Audio is unavailable");
  }

  const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
  const notes = analyzeAudioBuffer(buffer);
  importedSong = {
    name: file.name,
    notes,
    audioBuffer: buffer,
    type: "audio",
  };
  setStatus(`Generated ${notes.length} notes from ${file.name}. Start Round will play the song.`);
  logEvent(`generated chart from ${file.name} (${notes.length} notes)`);
}

async function importSongFile(file) {
  if (!file) return;

  const isMidi = /\.(mid|midi)$/i.test(file.name) || file.type === "audio/midi";
  const isAudio = file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name);

  try {
    if (isMidi) {
      await importMidiSong(file);
    } else if (isAudio) {
      await importAudioSong(file);
    } else {
      throw new Error("Use a MIDI file or an audio file like MP3");
    }
  } catch (error) {
    importedSong = null;
    midiFileInput.value = "";
    setStatus(`Could not load song: ${error.message}`);
    logEvent(`song import failed: ${error.message}`);
  }
}

function judgeNote(note) {
  if (!gameRunning) return;

  const targetY = getKeyboardLayout().keyboardTop - 20;
  let best = null;
  let bestDistance = Infinity;

  for (const item of fallingNotes) {
    if (item.hit || item.missed || item.note !== note) continue;
    const distance = Math.abs(item.y - targetY);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }

  if (!best || bestDistance > 78) {
    streak = 0;
    misses += 1;
    triggerKeyFlash(note, "#59a8ff", 0.8);
    recordJudgement("wrong", "#ff5d5d");
    refreshScoreboard();
    return;
  }

  best.hit = true;
  hits += 1;
  streak += 1;
  const perfect = bestDistance < 28;
  score += perfect ? 120 + streak * 2 : 70 + streak;
  triggerKeyFlash(note, perfect ? "#39d98a" : "#59a8ff", perfect ? 1.25 : 1);
  recordJudgement(perfect ? "perfect" : "good", perfect ? "#39d98a" : "#ffcc4d");
  refreshScoreboard();
}

function handleMidiMessage(event) {
  const [command, note, velocity] = event.data;
  const type = command & 0xf0;
  const isNoteOn = type === 0x90 && velocity > 0;
  const isNoteOff = type === 0x80 || (type === 0x90 && velocity === 0);

  if (isNoteOn) {
    activeNotes.set(note, velocity);
    triggerKeyFlash(note, "#59a8ff", Math.max(0.7, velocity / 127));
    playNote(note, velocity);
    logEvent("note on", note);
    judgeNote(note);
    updateLiveNotes();
  }

  if (isNoteOff) {
    activeNotes.delete(note);
    stopNote(note);
    logEvent("note off", note);
    updateLiveNotes();
  }
}

function detachSelectedInput() {
  if (selectedInput) {
    selectedInput.onmidimessage = null;
  }
  selectedInput = null;
}

function attachInput(inputId) {
  detachSelectedInput();
  if (!midiAccess) return;

  selectedInput = midiAccess.inputs.get(inputId) ?? null;
  if (!selectedInput) {
    setStatus("No MIDI input selected.");
    return;
  }

  selectedInput.onmidimessage = handleMidiMessage;
  setStatus(`Listening to ${selectedInput.name}. Play a key to see note numbers.`);
  startButton.disabled = false;
  logEvent(`connected to ${selectedInput.name}`);
}

function refreshInputs() {
  const inputs = [...midiAccess.inputs.values()];
  inputSelect.innerHTML = "";

  if (!inputs.length) {
    const option = document.createElement("option");
    option.textContent = "No MIDI inputs found";
    inputSelect.append(option);
    inputSelect.disabled = true;
    startButton.disabled = true;
    setStatus("No MIDI inputs found. Plug in the keyboard and allow MIDI access.");
    return;
  }

  for (const input of inputs) {
    const option = document.createElement("option");
    option.value = input.id;
    option.textContent = input.name || input.manufacturer || input.id;
    inputSelect.append(option);
  }

  inputSelect.disabled = false;
  attachInput(inputs[0].id);
}

async function connectMidi() {
  await ensureAudio();

  if (!("requestMIDIAccess" in navigator)) {
    setStatus("This browser does not support Web MIDI. Use Chrome or Edge.");
    logEvent("Web MIDI is unavailable in this browser");
    return;
  }

  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess.onstatechange = (event) => {
      logEvent(`${event.port.type} ${event.port.state}: ${event.port.name}`);
      refreshInputs();
    };
    permissionOverlay.classList.add("hidden");
    refreshInputs();
  } catch (error) {
    setStatus(`MIDI permission failed: ${error.message}`);
    logEvent(`MIDI permission failed: ${error.message}`);
  }
}

async function startRound() {
  await ensureAudio();
  resetGame();
  gameRunning = true;
  roundStartAt = performance.now() + 900;
  startBackingTrack(0.9);
  startButton.disabled = true;
  stopButton.disabled = false;
  const source = importedSong ? importedSong.name : "random notes";
  setStatus(`Round running: ${source}.`);
}

function stopRound() {
  gameRunning = false;
  stopBackingTrack();
  startButton.disabled = !selectedInput;
  stopButton.disabled = true;
  setStatus("Round stopped. Live note display still works.");
}

function clearHeldNotes() {
  activeNotes.clear();
  fallingNotes.length = 0;
  importedSong = null;
  midiFileInput.value = "";
  stopBackingTrack();
  stopAllNotes();
  updateLiveNotes();
  logEvent("cleared notes and song");
}

function drawKeyboardGuide(layout) {
  const targetY = layout.keyboardTop - 20;
  ctx.strokeStyle = "#3a4447";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, targetY);
  ctx.lineTo(viewWidth, targetY);
  ctx.stroke();

  ctx.fillStyle = "#a8b4b4";
  ctx.font = "14px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const modeLabel = whiteKeysOnly() ? "white keys only" : `notes ${layout.low}-${layout.high}`;
  ctx.fillText(`Hit line | ${modeLabel}`, viewWidth / 2, targetY - 10);
}

function drawPianoKeyboard(layout) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = "#171b1c";
  ctx.fillRect(0, layout.keyboardTop - 8, viewWidth, layout.keyboardBottom - layout.keyboardTop + 18);
  ctx.restore();

  for (const key of layout.whiteKeys) {
    const active = activeNotes.has(key.note);
    ctx.fillStyle = active ? "#39d98a" : "#f6f1e8";
    ctx.strokeStyle = active ? "#17663c" : "#a4a09a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(key.x + 1, key.y, key.width - 2, key.height, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = active ? "#06110b" : "#333736";
    ctx.font = "bold 13px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(key.note, key.centerX, key.y + key.height - 18);
  }

  for (const key of layout.blackKeys) {
    const active = activeNotes.has(key.note);
    const disabled = whiteKeysOnly();
    ctx.fillStyle = active ? "#ffcc4d" : disabled ? "#0d0f0f" : "#171717";
    ctx.strokeStyle = active ? "#6f5011" : disabled ? "#242929" : "#030303";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(key.x, key.y, key.width, key.height, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = active ? "#1b1404" : disabled ? "#5f6868" : "#f4f0e9";
    ctx.font = "bold 12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(key.note, key.centerX, key.y + key.height - 13);
  }
}

function drawFallingNotes(deltaSeconds, layout) {
  const speed = Number(speedInput.value);
  const targetY = layout.keyboardTop - 20;

  if (gameRunning && importedSong) {
    const elapsed = performance.now() - roundStartAt;
    const travelMs = ((targetY + 42) / speed) * 1000;

    while (songNoteIndex < importedSong.notes.length && importedSong.notes[songNoteIndex].timeMs <= elapsed + travelMs) {
      const event = importedSong.notes[songNoteIndex];
      spawnNote(fitNoteToRange(event.note), event.note);
      songNoteIndex += 1;
    }

    if (songNoteIndex >= importedSong.notes.length && !fallingNotes.some((note) => !note.hit && !note.missed)) {
      stopRound();
      setStatus(`Song complete: ${importedSong.name}.`);
    }
  } else if (gameRunning && performance.now() >= nextSpawnAt) {
    spawnNote();
    nextSpawnAt = performance.now() + Math.max(430, 1050 - streak * 12);
  }

  for (const item of fallingNotes) {
    item.y += speed * deltaSeconds;
    if (!item.hit && !item.missed && item.y > targetY + 92) {
      item.missed = true;
      misses += 1;
      streak = 0;
      recordJudgement("miss", "#ff5d5d");
      refreshScoreboard();
    }
  }

  for (let i = fallingNotes.length - 1; i >= 0; i -= 1) {
    const item = fallingNotes[i];
    if ((item.hit || item.missed) && item.y > viewHeight + 60) {
      fallingNotes.splice(i, 1);
    }
  }

  for (const item of fallingNotes) {
    const key = layout.keys.get(item.note);
    const x = key?.centerX ?? viewWidth / 2;
    const width = Math.max(18, Math.min(48, (key?.width ?? 48) * (key?.kind === "black" ? 0.9 : 0.72)));
    const height = 34;
    ctx.fillStyle = item.hit ? "rgba(57,217,138,0.35)" : item.missed ? "rgba(255,93,93,0.25)" : key?.kind === "black" ? "#ffcc4d" : "#59a8ff";
    ctx.beginPath();
    ctx.roundRect(x - width / 2, item.y - height / 2, width, height, 7);
    ctx.fill();
    ctx.fillStyle = key?.kind === "black" ? "#1b1404" : "#071018";
    ctx.font = "bold 21px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(item.note, x, item.y + 1);
    if (item.sourceNote !== item.note) {
      ctx.fillStyle = "#a8b4b4";
      ctx.font = "11px system-ui";
      ctx.fillText(item.sourceNote, x, item.y + 26);
    }
  }
}

function drawActiveKeys(layout) {
  for (const [note] of activeNotes) {
    const key = layout.keys.get(note);
    if (!key) continue;
    const x = key.centerX;
    const y = key.kind === "black" ? key.y + key.height + 18 : key.y - 26;
    ctx.fillStyle = "#39d98a";
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#07100d";
    ctx.font = "bold 14px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(note, x, y);
  }
}

function drawKeyFlashes(layout) {
  const now = performance.now();

  for (let i = keyFlashes.length - 1; i >= 0; i -= 1) {
    const flash = keyFlashes[i];
    const age = now - flash.createdAt;
    if (age > 650) {
      keyFlashes.splice(i, 1);
      continue;
    }

    const key = layout.keys.get(flash.note);
    if (!key) continue;

    const progress = age / 650;
    const alpha = 1 - progress;
    const expansion = (10 + 28 * progress) * flash.strength;
    const x = key.x - expansion / 2;
    const y = key.y - expansion / 2;
    const width = key.width + expansion;
    const height = key.height + expansion * 0.75;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = flash.color;
    ctx.lineWidth = Math.max(2, 8 * alpha * flash.strength);
    ctx.shadowColor = flash.color;
    ctx.shadowBlur = 22 * alpha;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.24;
    ctx.fillStyle = flash.color;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.fill();

    const burstY = key.kind === "black" ? key.y + key.height + 16 : key.y - 16;
    for (let dot = 0; dot < 6; dot += 1) {
      const angle = (Math.PI * 2 * dot) / 6;
      const radius = (8 + 28 * progress) * flash.strength;
      ctx.globalAlpha = alpha * 0.85;
      ctx.beginPath();
      ctx.arc(key.centerX + Math.cos(angle) * radius, burstY + Math.sin(angle) * radius * 0.45, 3.5 * alpha + 1, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}

function drawJudgements() {
  const now = performance.now();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 44px system-ui";
  recentJudgements.forEach((item, index) => {
    const age = now - item.createdAt;
    if (age > 1200) return;
    ctx.globalAlpha = Math.max(0, 1 - age / 1200);
    ctx.fillStyle = item.color;
    ctx.fillText(item.label.toUpperCase(), viewWidth / 2, 58 + index * 42);
    ctx.globalAlpha = 1;
  });
}

function drawIdleMessage() {
  if (gameRunning || permissionOverlay.classList.contains("hidden") === false) return;
  const maxWidth = Math.max(260, Math.min(720, viewWidth - 80));
  const headline = importedSong ? `Loaded: ${importedSong.name}` : "Start a round, then match falling notes to the keys.";
  const detail = importedSong
    ? "The song will be folded into the active keyboard range."
    : "Easy mode uses only notes 60-72. Import a MIDI file to generate a song round.";

  ctx.fillStyle = "#f3f6f4";
  ctx.font = "bold 22px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const headlineLines = wrapText(headline, maxWidth);
  const startY = Math.max(28, Math.min(layoutSafeMessageY(), viewHeight * 0.32));
  drawCenteredLines(headlineLines, viewWidth / 2, startY, 27);

  ctx.fillStyle = "#a8b4b4";
  ctx.font = "16px system-ui";
  drawCenteredLines(wrapText(detail, maxWidth), viewWidth / 2, startY + headlineLines.length * 27 + 12, 21);
}

function layoutSafeMessageY() {
  const layout = getKeyboardLayout();
  return Math.max(24, layout.keyboardTop - 156);
}

function drawFrame(now) {
  resizeCanvas();
  const deltaSeconds = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  ctx.clearRect(0, 0, viewWidth, viewHeight);
  ctx.fillStyle = "#0b0d0d";
  ctx.fillRect(0, 0, viewWidth, viewHeight);
  const layout = getKeyboardLayout();
  drawKeyboardGuide(layout);
  drawFallingNotes(deltaSeconds, layout);
  drawPianoKeyboard(layout);
  drawKeyFlashes(layout);
  drawActiveKeys(layout);
  drawJudgements();
  drawIdleMessage();

  animationFrame = requestAnimationFrame(drawFrame);
}

connectButton.addEventListener("click", connectMidi);
inputSelect.addEventListener("change", () => attachInput(inputSelect.value));
startButton.addEventListener("click", startRound);
stopButton.addEventListener("click", stopRound);
panicButton.addEventListener("click", clearHeldNotes);
volumeInput.addEventListener("input", updateMasterGain);
difficultySelect.addEventListener("change", () => {
  syncRangeInputs();
  fallingNotes.length = 0;
  setStatus(`Mode changed to ${difficultySelect.selectedOptions[0].text}.`);
});
whiteKeysOnlyInput.addEventListener("change", () => {
  fallingNotes.length = 0;
  setStatus(whiteKeysOnly() ? "White keys only enabled." : "Black key targets enabled.");
});
midiFileInput.addEventListener("change", () => importSongFile(midiFileInput.files[0]));

syncRangeInputs();
updateLiveNotes();
refreshScoreboard();
animationFrame = requestAnimationFrame(drawFrame);

window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationFrame);
  stopBackingTrack();
  stopAllNotes();
  detachSelectedInput();
});
