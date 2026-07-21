// Tuner state
let audioContext = null;
let analyser = null;
let mediaStream = null;
let animationFrameId = null;
let isRunning = false;
let lastFrequency = -1;
let frequencyHistory = [];

// UI Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const statusCard = document.getElementById('status');
const statusText = statusCard.querySelector('.status-text');
const noteDisplay = document.getElementById('note');
const frequencyDisplay = document.getElementById('frequency');
const centsDisplay = document.getElementById('cents');
const canvas = document.getElementById('tunerGraph');
const ctx = canvas.getContext('2d');

// Note definitions (A4 = 440 Hz)
const noteStrings = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const COLORS = {
  bg: '#060b14',
  grid: 'rgba(148, 163, 184, 0.12)',
  center: '#34d399',
  sharp: '#fb7185',
  flat: '#67e8f9',
  text: '#64748b',
  accent: '#38bdf8'
};

// Event listeners
startBtn.addEventListener('click', startTuner);
stopBtn.addEventListener('click', stopTuner);
resetBtn.addEventListener('click', stopTuner);

function setStatus(message, state = 'idle') {
  statusText.textContent = message;
  statusCard.classList.remove('active', 'error');
  if (state === 'active') {
    statusCard.classList.add('active');
  } else if (state === 'error') {
    statusCard.classList.add('error');
  }
}

function setRunningUI(running) {
  startBtn.hidden = running;
  stopBtn.hidden = !running;
  resetBtn.hidden = !running;
}

function setCentsDisplay(text, tone = '') {
  centsDisplay.textContent = text;
  centsDisplay.className = 'metric-value' + (tone ? ` ${tone}` : '');
}

function resetReadings() {
  noteDisplay.textContent = '—';
  frequencyDisplay.textContent = '— Hz';
  setCentsDisplay('—');
  lastFrequency = -1;
  frequencyHistory = [];
  clearGraph();
}

// Start the tuner
async function startTuner() {
  try {
    setStatus('Requesting audio access...', 'idle');

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.capture({
        audio: true,
        video: false
      }, (stream) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else if (stream) {
          resolve(stream);
        } else {
          reject(new Error('No stream returned'));
        }
      });
    });

    mediaStream = streamId;

    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    isRunning = true;
    setRunningUI(true);
    setStatus('Tuner active — play audio in this tab.', 'active');

    detectPitch();
  } catch (error) {
    console.error('Error starting tuner:', error);
    setStatus('Error: ' + error.message + '. Make sure audio is playing in this tab.', 'error');
  }
}

// Stop the tuner
function stopTuner() {
  isRunning = false;

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  setRunningUI(false);
  setStatus('Click start to begin tuning this tab.', 'idle');
  resetReadings();
}

// Pitch detection using autocorrelation
function detectPitch() {
  if (!isRunning) return;

  const bufferLength = analyser.fftSize;
  const buffer = new Float32Array(bufferLength);
  analyser.getFloatTimeDomainData(buffer);

  const rms = Math.sqrt(buffer.reduce((sum, val) => sum + val * val, 0) / buffer.length);

  if (rms < 0.01) {
    noteDisplay.textContent = '—';
    frequencyDisplay.textContent = '— Hz';
    setCentsDisplay('No signal');
    drawGraph(0, false);
  } else {
    const frequency = autoCorrelate(buffer, audioContext.sampleRate);

    if (frequency > 0) {
      const smoothedFrequency = smoothFrequency(frequency);
      const note = frequencyToNote(smoothedFrequency);
      const cents = frequencyToCents(smoothedFrequency, note.frequency);

      noteDisplay.textContent = note.name + note.octave;
      frequencyDisplay.textContent = smoothedFrequency.toFixed(2) + ' Hz';

      if (Math.abs(cents) < 5) {
        setCentsDisplay('In tune', 'in-tune');
      } else if (cents > 0) {
        setCentsDisplay('+' + cents.toFixed(0) + '¢ sharp', 'sharp');
      } else {
        setCentsDisplay(cents.toFixed(0) + '¢ flat', 'flat');
      }

      drawGraph(cents, true);
    } else {
      noteDisplay.textContent = '—';
      frequencyDisplay.textContent = '— Hz';
      setCentsDisplay('Detecting...');
      drawGraph(0, false);
    }
  }

  animationFrameId = requestAnimationFrame(detectPitch);
}

// Autocorrelation algorithm for pitch detection
function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);

  const MIN_FREQUENCY = 82;
  const MAX_FREQUENCY = 1000;
  const MAX_OFFSET = Math.floor(sampleRate / MIN_FREQUENCY);
  const MIN_OFFSET = Math.floor(sampleRate / MAX_FREQUENCY);
  const CORRELATION_THRESHOLD = 0.5;

  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    const val = buffer[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);

  if (rms < 0.01) return -1;

  const normalizedBuffer = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    normalizedBuffer[i] = buffer[i] / rms;
  }

  const maxOffset = Math.min(MAX_OFFSET, MAX_SAMPLES);
  const correlations = new Float32Array(maxOffset);

  for (let offset = MIN_OFFSET; offset < maxOffset; offset++) {
    let correlation = 0;

    for (let i = 0; i < MAX_SAMPLES; i++) {
      correlation += normalizedBuffer[i] * normalizedBuffer[i + offset];
    }

    correlations[offset] = correlation / MAX_SAMPLES;
  }

  let best_offset = -1;
  let best_correlation = 0;

  for (let offset = MIN_OFFSET + 1; offset < maxOffset - 1; offset++) {
    const current = correlations[offset];
    const prev = correlations[offset - 1];
    const next = correlations[offset + 1];

    if (current > prev && current > next && current > CORRELATION_THRESHOLD) {
      if (current > best_correlation) {
        best_correlation = current;
        best_offset = offset;
      }
      if (current > 0.9) {
        break;
      }
    }
  }

  if (best_offset === -1) {
    for (let offset = MIN_OFFSET; offset < maxOffset; offset++) {
      if (correlations[offset] > best_correlation) {
        best_correlation = correlations[offset];
        best_offset = offset;
      }
    }
  }

  if (best_correlation > CORRELATION_THRESHOLD && best_offset !== -1) {
    let refined_offset = best_offset;

    if (best_offset > MIN_OFFSET && best_offset < maxOffset - 1) {
      const c1 = correlations[best_offset - 1];
      const c2 = correlations[best_offset];
      const c3 = correlations[best_offset + 1];

      const delta = 0.5 * (c1 - c3) / (c1 - 2 * c2 + c3);
      if (!isNaN(delta) && Math.abs(delta) < 1) {
        refined_offset = best_offset + delta;
      }
    }

    const frequency = sampleRate / refined_offset;

    if (frequency >= MIN_FREQUENCY && frequency <= MAX_FREQUENCY) {
      return frequency;
    }
  }

  return -1;
}

function smoothFrequency(frequency) {
  const HISTORY_SIZE = 5;
  const SMOOTHING_FACTOR = 0.7;
  const OCTAVE_DOWN_THRESHOLD = 0.1;
  const OCTAVE_UP_THRESHOLD = 0.2;

  frequencyHistory.push(frequency);
  if (frequencyHistory.length > HISTORY_SIZE) {
    frequencyHistory.shift();
  }

  if (lastFrequency > 0) {
    const ratio = frequency / lastFrequency;

    if (Math.abs(ratio - 0.5) < OCTAVE_DOWN_THRESHOLD || Math.abs(ratio - 2.0) < OCTAVE_UP_THRESHOLD) {
      frequency = lastFrequency * 0.9 + frequency * 0.1;
    } else if (Math.abs(ratio - 1.0) < 0.5) {
      frequency = lastFrequency * SMOOTHING_FACTOR + frequency * (1 - SMOOTHING_FACTOR);
    } else if (frequencyHistory.length >= 3) {
      const sorted = [...frequencyHistory].sort((a, b) => a - b);
      frequency = sorted[Math.floor(sorted.length / 2)];
    }
  }

  lastFrequency = frequency;
  return frequency;
}

function frequencyToNote(frequency) {
  const noteNum = 12 * (Math.log(frequency / 440) / Math.log(2));
  const noteIndex = Math.round(noteNum) + 69;
  const octave = Math.floor(noteIndex / 12) - 1;
  const noteName = noteStrings[noteIndex % 12];
  const idealFrequency = 440 * Math.pow(2, (noteIndex - 69) / 12);

  return {
    name: noteName,
    octave: octave,
    frequency: idealFrequency,
    midiNote: noteIndex
  };
}

function frequencyToCents(frequency, idealFrequency) {
  return Math.floor(1200 * Math.log(frequency / idealFrequency) / Math.log(2));
}

function drawGraph(cents, hasSignal) {
  const width = canvas.width;
  const height = canvas.height;
  const centerY = height / 2;
  const paddingX = 18;

  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;

  for (let i = 1; i < 4; i++) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(paddingX, y);
    ctx.lineTo(width - paddingX, y);
    ctx.stroke();
  }

  ctx.strokeStyle = COLORS.grid;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(paddingX, centerY - 25);
  ctx.lineTo(width - paddingX, centerY - 25);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(paddingX, centerY + 25);
  ctx.lineTo(width - paddingX, centerY + 25);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = COLORS.center;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(paddingX, centerY);
  ctx.lineTo(width - paddingX, centerY);
  ctx.stroke();

  ctx.fillStyle = COLORS.text;
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('+50¢', paddingX, 16);
  ctx.fillText('0¢', paddingX, centerY - 8);
  ctx.fillText('-50¢', paddingX, height - 8);

  if (hasSignal) {
    const clampedCents = Math.max(-50, Math.min(50, cents));
    const indicatorY = centerY - clampedCents;

    let color;
    if (Math.abs(cents) < 5) {
      color = COLORS.center;
    } else if (cents > 0) {
      color = COLORS.sharp;
    } else {
      color = COLORS.flat;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width / 2, indicatorY);
    ctx.lineTo(width / 2, centerY);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(width / 2, indicatorY, 7, 0, 2 * Math.PI);
    ctx.fill();

    ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(width / 2, indicatorY, 7, 0, 2 * Math.PI);
    ctx.stroke();
  } else {
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for signal', width / 2, centerY + 4);
  }
}

function clearGraph() {
  drawGraph(0, false);
}

clearGraph();
