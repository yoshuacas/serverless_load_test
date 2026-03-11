// === State ===
let running = false;
let startTime = null;
let timerInterval = null;
let tickInterval = null;
let tick = 0;
let selectedScenario = 'gradual_ramp';
let totalCost = 0;
let lastEcpuCapacity = 30000;

const MAX_POINTS = 180;
const TICK_MS = 800;

// Seeded random for reproducible demo data
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// === Scenario presets ===
const SCENARIOS = {
  gradual_ramp: {
    cfgRps: 5000, cfgPayload: 1, cfgRatio: 80, cfgKeyDist: 'uniform',
    cfgDuration: 5, cfgLambdas: 20, cfgClients: 3, cfgInflight: 1000, cfgCommand: 'get_set'
  },
  sudden_spike: {
    cfgRps: 10000, cfgPayload: 1, cfgRatio: 80, cfgKeyDist: 'uniform',
    cfgDuration: 5, cfgLambdas: 50, cfgClients: 3, cfgInflight: 1000, cfgCommand: 'get_set'
  },
  large_payloads: {
    cfgRps: 2000, cfgPayload: 50, cfgRatio: 70, cfgKeyDist: 'uniform',
    cfgDuration: 10, cfgLambdas: 10, cfgClients: 2, cfgInflight: 1000, cfgCommand: 'get_set'
  },
  memory_growth: {
    cfgRps: 10000, cfgPayload: 10, cfgRatio: 20, cfgKeyDist: 'uniform',
    cfgDuration: 15, cfgLambdas: 20, cfgClients: 3, cfgInflight: 1000, cfgCommand: 'get_set'
  },
  hot_key: {
    cfgRps: 8000, cfgPayload: 1, cfgRatio: 90, cfgKeyDist: 'zipf',
    cfgDuration: 5, cfgLambdas: 30, cfgClients: 5, cfgInflight: 500, cfgCommand: 'get_set'
  },
  quick_test: {
    cfgRps: 500, cfgPayload: 1, cfgRatio: 80, cfgKeyDist: 'uniform',
    cfgDuration: 1, cfgLambdas: 2, cfgClients: 2, cfgInflight: 500, cfgCommand: 'get_set'
  }
};

// === Realistic ElastiCache Serverless Scaling Model ===
// Models: capacity tracking, burst budget, doubling intervals, throttle behavior

function createScalingState() {
  return {
    currentCapacityEcpu: 30000,   // starts at 30K for empty cache
    lastScaleTime: 0,
    burstBudget: 1.0,             // 0-1, refills over time, consumed on spikes
    memoryUsedGb: 0.5,            // baseline
    memoryCapacityGb: 5,
    totalThrottled: 0,
    totalRequests: 0,
    peakRps: 0,
  };
}

function simulateElastiCacheScaling(state, t, demandEcpu, scenario) {
  const BURST_HEADROOM = 0.30;       // 25-35% instant burst
  const DOUBLE_INTERVAL = 600;        // doubles every ~10 min (600s)
  const BURST_REFILL_RATE = 0.002;    // refills ~0.2% per second

  // Refill burst budget
  state.burstBudget = Math.min(1.0, state.burstBudget + BURST_REFILL_RATE);

  // Check if demand exceeds capacity
  const effectiveCapacity = state.currentCapacityEcpu * (1 + BURST_HEADROOM * state.burstBudget);

  let throttled = 0;
  let servedEcpu = demandEcpu;
  let latencyMultiplier = 1.0;

  if (demandEcpu > effectiveCapacity) {
    // Throttling occurs
    const overflow = demandEcpu - effectiveCapacity;
    throttled = Math.round((overflow / demandEcpu) * 100);  // % of requests throttled
    servedEcpu = Math.round(effectiveCapacity);
    state.burstBudget = Math.max(0, state.burstBudget - 0.15); // drain burst budget
    latencyMultiplier = 1.5 + (overflow / effectiveCapacity) * 3; // latency spikes during overload
  } else if (demandEcpu > state.currentCapacityEcpu * 0.85) {
    // Near capacity — slight latency increase
    latencyMultiplier = 1.0 + (demandEcpu / effectiveCapacity) * 0.3;
  }

  // Scaling: capacity doubles every DOUBLE_INTERVAL seconds if demand warrants it
  const timeSinceLastScale = t - state.lastScaleTime;
  if (timeSinceLastScale >= DOUBLE_INTERVAL / 10 && demandEcpu > state.currentCapacityEcpu * 0.7) {
    // Scale up incrementally (simulating the doubling over 10-12 min)
    const scaleStep = state.currentCapacityEcpu * 0.08; // ~8% per minute
    state.currentCapacityEcpu = Math.round(state.currentCapacityEcpu + scaleStep);
    state.lastScaleTime = t;
  }

  // Also instant scale-up if burst is used (ElastiCache adjusts quickly for sustained load)
  if (demandEcpu > state.currentCapacityEcpu && state.burstBudget < 0.3) {
    state.currentCapacityEcpu = Math.round(state.currentCapacityEcpu * 1.15);
    state.lastScaleTime = t;
  }

  state.totalThrottled += throttled;
  state.totalRequests += 100; // normalized

  return { servedEcpu, throttled, latencyMultiplier, capacity: state.currentCapacityEcpu };
}

function generateRealisticTick(t, scenario, config, state, rng) {
  const duration = config.duration * 60;
  const progress = Math.min(t / duration, 1);
  const targetRpsTotal = config.rps * config.lambdas;
  const payloadKb = config.payload;
  const noise = () => (rng() - 0.5) * 0.1;

  let demandRps, effectivePayloadKb, memoryWrite;

  switch (scenario) {
    case 'gradual_ramp': {
      // Smooth S-curve ramp: slow start, fast middle, plateau
      const curve = 1 / (1 + Math.exp(-12 * (progress - 0.4)));
      demandRps = Math.round(targetRpsTotal * curve * (1 + noise()));
      effectivePayloadKb = payloadKb;
      memoryWrite = progress * 0.4; // slow memory growth from cached data
      break;
    }
    case 'sudden_spike': {
      // 15s warm-up at 5%, then instant spike to 100%
      const spikeTime = 15;
      const recoveryStart = spikeTime + 45; // throttle for ~45s then capacity catches up
      if (t < spikeTime) {
        demandRps = Math.round(targetRpsTotal * 0.05 * (1 + noise()));
      } else {
        demandRps = Math.round(targetRpsTotal * (1 + noise()));
      }
      effectivePayloadKb = payloadKb;
      memoryWrite = 0.1;
      break;
    }
    case 'large_payloads': {
      // RPS stays constant, payload grows in steps every 30s
      demandRps = Math.round(targetRpsTotal * (0.9 + rng() * 0.2));
      const payloadStep = Math.floor(t / 30);
      effectivePayloadKb = Math.min(payloadKb, 1 + payloadStep * 5); // 1KB -> 6 -> 11 -> ... -> 50KB
      memoryWrite = effectivePayloadKb * 0.01;
      break;
    }
    case 'memory_growth': {
      // Steady high-write RPS, unique keys, no TTL
      demandRps = Math.round(targetRpsTotal * (0.92 + rng() * 0.08));
      effectivePayloadKb = payloadKb;
      // Memory grows proportionally: RPS * payload * write_ratio * time
      const writeRatio = 1 - (config.ratio / 100);
      memoryWrite = (demandRps * effectivePayloadKb * writeRatio * t) / (1024 * 1024 * 8);
      break;
    }
    case 'hot_key': {
      // Steady RPS but hot-key causes shard imbalance
      demandRps = Math.round(targetRpsTotal * (0.88 + rng() * 0.12));
      effectivePayloadKb = payloadKb;
      memoryWrite = progress * 0.15;
      break;
    }
    default:
      demandRps = Math.round(targetRpsTotal * progress);
      effectivePayloadKb = payloadKb;
      memoryWrite = 0.1;
  }

  // ECPU demand = RPS * payload_KB (core ElastiCache formula)
  const demandEcpu = Math.round(demandRps * effectivePayloadKb * (1 + noise()));

  // Run through scaling model
  const scaling = simulateElastiCacheScaling(state, t, demandEcpu, scenario);

  // Base latency: sub-millisecond for ElastiCache
  let baseP50 = 0.4 + rng() * 0.2; // 0.4-0.6ms typical
  let baseP90 = baseP50 * 1.6 + rng() * 0.3;
  let baseP99 = baseP90 * 1.5 + rng() * 0.4;

  // Hot key: periodic latency spikes from shard concentration
  if (scenario === 'hot_key') {
    const shardPressure = 1 + Math.sin(t * 0.15) * 0.5 + rng() * 0.8;
    baseP50 *= shardPressure;
    baseP90 *= shardPressure * 1.3;
    baseP99 *= shardPressure * 1.5;
    // Occasional big spikes (p99 and p90 diverge)
    if (rng() < 0.08) {
      baseP99 *= 3 + rng() * 4;
      baseP90 *= 1.5 + rng() * 1.5;
    }
  }

  // Apply scaling pressure to latency
  const p50 = +(baseP50 * scaling.latencyMultiplier).toFixed(2);
  const p90 = +(baseP90 * scaling.latencyMultiplier).toFixed(2);
  const p99 = +(baseP99 * scaling.latencyMultiplier).toFixed(2);

  // Memory
  state.memoryUsedGb = +(0.5 + memoryWrite).toFixed(3);

  // Connections: proportional to active lambdas
  const rpsRatio = demandRps / Math.max(targetRpsTotal, 1);
  // Glide: each client = 1 multiplexed connection per node. Track client instances.
  const activeClients = Math.round(config.lambdas * config.clients * rpsRatio * (0.95 + rng() * 0.1));

  // Cost
  const costPerEcpu = 0.0000000034;
  const costPerGbHr = 0.125 / 3600;
  const tickCost = scaling.servedEcpu * costPerEcpu + state.memoryUsedGb * costPerGbHr;

  return {
    demandRps,
    actualRps: Math.round(demandRps * (1 - scaling.throttled / 100)),
    targetRps: targetRpsTotal,
    ecpuDemand: demandEcpu,
    ecpuServed: scaling.servedEcpu,
    ecpuCapacity: scaling.capacity,
    throttled: scaling.throttled,
    p50, p90, p99,
    memory: state.memoryUsedGb,
    activeClients,
    cost: +tickCost.toFixed(6),
    effectivePayloadKb,
    latencyMultiplier: scaling.latencyMultiplier
  };
}

// === Chart setup ===
const chartOpts = (yLabel, suggestedMax) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: { intersect: false, mode: 'index' },
  scales: {
    x: {
      display: true,
      grid: { color: 'rgba(255,255,255,0.04)' },
      ticks: { color: '#6b7280', font: { size: 10 }, maxTicksLimit: 12 }
    },
    y: {
      display: true,
      grid: { color: 'rgba(255,255,255,0.04)' },
      ticks: { color: '#6b7280', font: { size: 10 } },
      suggestedMax,
      beginAtZero: true
    }
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#1e2028',
      borderColor: '#2a2d37',
      borderWidth: 1,
      titleColor: '#f1f3f5',
      bodyColor: '#9ca3af',
      padding: 10,
      cornerRadius: 6,
      titleFont: { size: 12, weight: 600 },
      bodyFont: { size: 11 }
    }
  }
});

function makeDataset(label, color, dashed) {
  return {
    label,
    data: [],
    borderColor: color,
    backgroundColor: dashed ? 'transparent' : color + '15',
    borderWidth: dashed ? 1.5 : 2,
    borderDash: dashed ? [5, 5] : [],
    pointRadius: 0,
    tension: 0.35,
    fill: !dashed
  };
}

function makeBarDataset(label, color) {
  return {
    label,
    data: [],
    backgroundColor: color + '90',
    borderColor: color,
    borderWidth: 1,
    borderRadius: 2,
    barPercentage: 0.7
  };
}

const labels = [];

const chartLatency = new Chart(document.getElementById('chartLatency'), {
  type: 'line',
  data: { labels, datasets: [makeDataset('p50', '#6366f1'), makeDataset('p90', '#10b981'), makeDataset('p99', '#f59e0b')] },
  options: chartOpts('ms', 5)
});

const chartRps = new Chart(document.getElementById('chartRps'), {
  type: 'line',
  data: { labels, datasets: [makeDataset('Actual', '#10b981'), makeDataset('Target', '#4b5563', true)] },
  options: chartOpts('req/s', 100000)
});

const chartEcpu = new Chart(document.getElementById('chartEcpu'), {
  type: 'line',
  data: { labels, datasets: [makeDataset('Demand', '#8b5cf6'), makeDataset('Capacity', '#4b5563', true)] },
  options: chartOpts('ECPU/s', 50000)
});

const chartThrottle = new Chart(document.getElementById('chartThrottle'), {
  type: 'bar',
  data: { labels, datasets: [makeBarDataset('Throttled %', '#ef4444')] },
  options: chartOpts('% requests', 100)
});

const chartMemory = new Chart(document.getElementById('chartMemory'), {
  type: 'line',
  data: { labels, datasets: [makeDataset('Used', '#06b6d4')] },
  options: chartOpts('GB', 5)
});

const chartConnections = new Chart(document.getElementById('chartConnections'), {
  type: 'line',
  data: { labels, datasets: [makeDataset('Glide Clients', '#f59e0b')] },
  options: chartOpts('clients', 200)
});

const allCharts = [chartLatency, chartRps, chartEcpu, chartThrottle, chartMemory, chartConnections];

// === Push a tick of data into all charts ===
function pushTickToCharts(t, d) {
  const lbl = t % 15 === 0 ? formatTime(t) : '';
  if (labels.length >= MAX_POINTS) {
    labels.shift();
    allCharts.forEach(c => c.data.datasets.forEach(ds => ds.data.shift()));
  }
  labels.push(lbl);

  chartLatency.data.datasets[0].data.push(d.p50);
  chartLatency.data.datasets[1].data.push(d.p90);
  chartLatency.data.datasets[2].data.push(d.p99);
  chartRps.data.datasets[0].data.push(d.actualRps);
  chartRps.data.datasets[1].data.push(d.targetRps);
  chartEcpu.data.datasets[0].data.push(d.ecpuDemand);
  chartEcpu.data.datasets[1].data.push(d.ecpuCapacity);
  chartThrottle.data.datasets[0].data.push(d.throttled);
  chartMemory.data.datasets[0].data.push(d.memory);
  chartConnections.data.datasets[0].data.push(d.activeClients);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m${sec > 0 ? String(sec).padStart(2, '0') + 's' : ''}` : `${sec}s`;
}

// === Pre-seed charts with demo data for a scenario ===
function seedScenario(scenario) {
  const preset = SCENARIOS[scenario];
  const config = {
    rps: preset.cfgRps,
    payload: preset.cfgPayload,
    ratio: preset.cfgRatio,
    duration: preset.cfgDuration,
    lambdas: preset.cfgLambdas,
    clients: preset.cfgClients,
    inflight: preset.cfgInflight
  };

  // Clear existing data
  labels.length = 0;
  allCharts.forEach(c => {
    c.data.datasets.forEach(ds => { ds.data.length = 0; });
  });

  const state = createScalingState();
  const rng = seededRandom(scenario.length * 1337 + 42);
  totalCost = 0;

  // Seed points — simulate a completed run of ~150 ticks
  const seedCount = 150;
  const events = [];
  let lastLogCapacity = 30000;

  for (let t = 1; t <= seedCount; t++) {
    const d = generateRealisticTick(t, scenario, config, state, rng);
    totalCost += d.cost;
    pushTickToCharts(t, d);

    // Collect events
    if (state.currentCapacityEcpu > lastLogCapacity * 1.2) {
      events.push({ t, type: 'scale', msg: `ECPU capacity scaled: ${lastLogCapacity.toLocaleString()} -> ${state.currentCapacityEcpu.toLocaleString()} ECPU/s` });
      lastLogCapacity = state.currentCapacityEcpu;
    }
    if (d.throttled > 10) {
      events.push({ t, type: 'warn', msg: `Throttling: ${d.throttled}% of requests throttled at t=${t}s` });
    }
  }

  allCharts.forEach(c => c.update('none'));

  // Update KPIs with final values
  const last = generateRealisticTick(seedCount, scenario, config, state, rng);
  updateKpis(last, seedCount);

  // Populate event log
  clearLog();
  addEvent('info', `Scenario: ${scenario.replace(/_/g, ' ')}`);
  addEvent('info', `Config: ${config.lambdas} Lambdas x ${config.rps.toLocaleString()} RPS = ${(config.lambdas * config.rps).toLocaleString()} total RPS`)
  addEvent('info', `Glide: ${config.clients} clients/Lambda x ${config.inflight} inflight = ${(config.lambdas * config.clients).toLocaleString()} total clients`);
  addEvent('info', `Payload: ${config.payload}KB | Duration: ${config.duration}min`);
  addEvent('scale', `ElastiCache initial capacity: 30,000 ECPU/s`);

  // Add notable events (limit to most interesting ones)
  const notable = [];
  const seenTypes = { scale: 0, warn: 0 };
  for (const ev of events) {
    if (ev.type === 'scale' && seenTypes.scale < 5) {
      notable.push(ev);
      seenTypes.scale++;
    }
    if (ev.type === 'warn' && seenTypes.warn < 3) {
      notable.push(ev);
      seenTypes.warn++;
    }
  }
  notable.sort((a, b) => a.t - b.t);
  for (const ev of notable) {
    addEventAt(ev.type, ev.msg, ev.t);
  }

  if (state.totalThrottled === 0) {
    addEvent('success', 'Zero throttling throughout the test');
  }
  addEvent('success', `Completed. Peak capacity: ${state.currentCapacityEcpu.toLocaleString()} ECPU/s | Cost: $${totalCost.toFixed(4)}`);

  // Update timer display
  document.getElementById('elapsed').textContent = formatTime(seedCount);

  // Status
  const pill = document.getElementById('statusPill');
  pill.classList.remove('running');
  pill.querySelector('.status-text').textContent = 'Completed';
  pill.querySelector('.status-dot').style.background = '#10b981';
}

// === Update KPI cards ===
function updateKpis(d, t) {
  document.getElementById('kpiRps').textContent = d.actualRps.toLocaleString();
  document.getElementById('kpiLatency').innerHTML = d.p50.toFixed(1) + ' <small>/</small> ' + d.p90.toFixed(1) + ' <small>/</small> ' + d.p99.toFixed(1) + '<small>ms</small>';
  document.getElementById('kpiEcpu').textContent = d.ecpuDemand.toLocaleString();
  document.getElementById('kpiThrottle').textContent = d.throttled > 0 ? d.throttled + '%' : '0';
  document.getElementById('kpiMemory').innerHTML = d.memory.toFixed(1) + '<small>GB</small>';
  document.getElementById('kpiCost').textContent = '$' + totalCost.toFixed(4);

  // Trends
  const rpsRatio = Math.round((d.actualRps / d.targetRps) * 100);
  setTrendEl('kpiRpsTrend', rpsRatio + '% of target', rpsRatio >= 85);

  setTrendEl('kpiLatencyTrend', d.p99 < 2 ? 'sub-2ms p99' : 'p99: ' + d.p99.toFixed(1) + 'ms', d.p99 < 5);
  setTrendEl('kpiEcpuTrend', Math.round(d.ecpuDemand / d.ecpuCapacity * 100) + '% of capacity', d.ecpuDemand < d.ecpuCapacity * 0.85);
  setTrendEl('kpiThrottleTrend', d.throttled === 0 ? 'none' : d.throttled + '% rejected', d.throttled === 0);
  setTrendEl('kpiMemoryTrend', d.memory < 1 ? 'minimal' : d.memory.toFixed(1) + ' GB used', true);
  setTrendEl('kpiCostTrend', '$' + (totalCost * 3600 / Math.max(t, 1)).toFixed(2) + '/hr rate', true);
}

// === Scenario selection ===
document.getElementById('scenarioCards').addEventListener('click', (e) => {
  const card = e.target.closest('.scenario-card');
  if (!card || running) return;

  document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');
  selectedScenario = card.dataset.scenario;

  const preset = SCENARIOS[selectedScenario];
  if (preset) {
    document.getElementById('cfgRps').value = preset.cfgRps;
    document.getElementById('cfgPayload').value = preset.cfgPayload;
    document.getElementById('cfgRatio').value = preset.cfgRatio;
    document.getElementById('cfgRatioValue').textContent = preset.cfgRatio + '/' + (100 - preset.cfgRatio);
    document.getElementById('cfgKeyDist').value = preset.cfgKeyDist;
    document.getElementById('cfgDuration').value = preset.cfgDuration;
    document.getElementById('cfgLambdas').value = preset.cfgLambdas;
    document.getElementById('cfgClients').value = preset.cfgClients;
    document.getElementById('cfgInflight').value = preset.cfgInflight;
    document.getElementById('cfgCommand').value = preset.cfgCommand;
  }

  // Try real data first, fall back to simulation
  tryLoadRealResults(selectedScenario).then(loaded => {
    if (!loaded) seedScenario(selectedScenario);
  });
});

// Slider live update
document.getElementById('cfgRatio').addEventListener('input', (e) => {
  const v = e.target.value;
  document.getElementById('cfgRatioValue').textContent = v + '/' + (100 - v);
});

// === API base URL (same origin via CloudFront, or localhost for dev) ===
const API_BASE = '/api';

// === Start a REAL test via the API ===
let pollTimer = null;

async function startDemo() {
  if (running) return;
  running = true;
  startTime = Date.now();
  totalCost = 0;

  // Reset charts
  labels.length = 0;
  allCharts.forEach(c => {
    c.data.datasets.forEach(ds => { ds.data.length = 0; });
    c.update('none');
  });

  // Build config overrides from the UI
  const configOverrides = {
    target_rps: +document.getElementById('cfgRps').value,
    payload_size_bytes: +document.getElementById('cfgPayload').value * 1024,
    read_write_ratio: +document.getElementById('cfgRatio').value / 100,
    key_distribution: document.getElementById('cfgKeyDist').value,
    duration_seconds: +document.getElementById('cfgDuration').value * 60,
    lambda_count: +document.getElementById('cfgLambdas').value,
    client_count: +document.getElementById('cfgClients').value,
    inflight_requests_limit: +document.getElementById('cfgInflight').value,
    command_type: document.getElementById('cfgCommand').value,
  };

  // UI state
  document.getElementById('btnRun').disabled = true;
  document.getElementById('btnStop').disabled = false;
  const pill = document.getElementById('statusPill');
  pill.classList.add('running');
  pill.querySelector('.status-text').textContent = 'Starting...';
  pill.querySelector('.status-dot').style.background = '';

  clearLog();
  addEvent('info', `Launching: ${selectedScenario.replace(/_/g, ' ')}`);
  addEvent('info', `Target: ${(configOverrides.target_rps * configOverrides.lambda_count).toLocaleString()} total RPS | ${configOverrides.lambda_count} Lambdas`);

  try {
    const resp = await fetch(`${API_BASE}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: selectedScenario, config: configOverrides }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      addEvent('warn', `API error: ${data.error || resp.statusText}`);
      stopDemo();
      return;
    }

    const executionName = data.execution_name;
    addEvent('info', `Execution started: ${executionName}`);
    addEvent('info', `Waiting for ${configOverrides.lambda_count} Lambdas to complete...`);

    pill.querySelector('.status-text').textContent = 'Running';

    // Timer
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById('elapsed').textContent = formatTime(elapsed);
    }, 500);

    // Poll for completion
    pollTimer = setInterval(async () => {
      try {
        const statusResp = await fetch(`${API_BASE}/executions/${executionName}`);
        const statusData = await statusResp.json();

        if (statusData.status === 'SUCCEEDED') {
          clearInterval(pollTimer);
          pollTimer = null;
          addEvent('success', 'Execution succeeded! Loading results...');
          if (statusData.results) {
            loadRealResults(statusData.results);
          }
          stopDemo();
        } else if (statusData.status === 'FAILED' || statusData.status === 'TIMED_OUT' || statusData.status === 'ABORTED') {
          clearInterval(pollTimer);
          pollTimer = null;
          addEvent('warn', `Execution ${statusData.status}: ${statusData.error || ''}`);
          stopDemo();
        }
        // else still RUNNING — keep polling
      } catch (e) {
        addEvent('warn', `Poll error: ${e.message}`);
      }
    }, 5000);

  } catch (e) {
    addEvent('warn', `Failed to start: ${e.message}`);
    stopDemo();
  }
}

function stopDemo() {
  running = false;
  clearInterval(timerInterval);
  clearInterval(tickInterval);
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  document.getElementById('btnRun').disabled = false;
  document.getElementById('btnStop').disabled = true;
  const pill = document.getElementById('statusPill');
  pill.classList.remove('running');
  if (pill.querySelector('.status-text').textContent === 'Running' ||
      pill.querySelector('.status-text').textContent === 'Starting...') {
    pill.querySelector('.status-text').textContent = 'Stopped';
  }
}

// === Helpers ===
function setTrendEl(id, text, good) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'kpi-trend ' + (good ? 'up' : 'down');
}

function addEvent(type, msg) {
  const log = document.getElementById('eventLog');
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');

  const div = document.createElement('div');
  div.className = 'event-item ' + type;
  div.innerHTML = `<span class="event-time">${time}</span><span class="event-msg">${msg}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function addEventAt(type, msg, t) {
  const log = document.getElementById('eventLog');
  const div = document.createElement('div');
  div.className = 'event-item ' + type;
  div.innerHTML = `<span class="event-time">t=${t}s</span><span class="event-msg">${msg}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  document.getElementById('eventLog').innerHTML = '';
}

// === Load real results from aggregated JSON ===
function loadRealResults(data) {
  const scenario = data.scenario || 'unknown';
  const config = data.config || {};
  const ts = data.time_series || [];
  const events = data.events || [];
  const summary = data.summary || {};

  if (ts.length === 0) return false;

  // Clear charts
  labels.length = 0;
  allCharts.forEach(c => {
    c.data.datasets.forEach(ds => { ds.data.length = 0; });
  });

  totalCost = 0;
  const startTs = ts[0].timestamp_s;

  for (let i = 0; i < ts.length; i++) {
    const d = ts[i];
    const t = d.timestamp_s - startTs;
    totalCost = d.cumulative_cost_usd || totalCost + (d.window_cost_usd || 0);

    pushTickToCharts(t, {
      actualRps: d.actual_rps || 0,
      targetRps: d.target_rps || 0,
      p50: d.p50_ms || 0,
      p90: d.p90_ms || 0,
      p99: d.p99_ms || 0,
      ecpuDemand: d.ecpu_demand || 0,
      ecpuCapacity: d.ecpu_capacity_estimate || 0,
      throttled: d.throttle_pct || 0,
      memory: d.cumulative_bytes_written_gb || 0,
      activeClients: d.active_clients || 0,
    });
  }

  allCharts.forEach(c => c.update('none'));

  // Update KPIs with last data point
  const last = ts[ts.length - 1];
  const elapsed = last.timestamp_s - startTs;
  updateKpis({
    actualRps: last.actual_rps || 0,
    targetRps: last.target_rps || 0,
    p50: last.p50_ms || 0,
    p90: last.p90_ms || 0,
    p99: last.p99_ms || 0,
    ecpuDemand: last.ecpu_demand || 0,
    ecpuCapacity: last.ecpu_capacity_estimate || 0,
    throttled: last.throttle_pct || 0,
    memory: last.cumulative_bytes_written_gb || 0,
    cost: last.window_cost_usd || 0,
  }, elapsed);

  document.getElementById('elapsed').textContent = formatTime(elapsed);

  // Populate event log
  clearLog();
  addEvent('info', `REAL DATA: ${scenario.replace(/_/g, ' ')}`);
  addEvent('info', `Lambdas: ${config.lambda_count || '?'} x ${(config.target_rps || 0).toLocaleString()} RPS | Payload: ${((config.payload_size_bytes || 1024) / 1024).toFixed(0)}KB`);

  for (const ev of events) {
    addEventAt(ev.type || 'info', ev.message || '', ev.timestamp_s ? ev.timestamp_s - startTs : 0);
  }

  if (summary.peak_rps) addEvent('info', `Peak RPS: ${summary.peak_rps.toLocaleString()}`);
  if (summary.peak_p99_ms) addEvent('info', `Peak p99: ${summary.peak_p99_ms.toFixed(2)}ms`);
  if (summary.total_cost_usd) addEvent('success', `Total cost: $${summary.total_cost_usd.toFixed(4)}`);
  addEvent('success', `Real test completed — ${ts.length} data points`);

  // Status pill
  const pill = document.getElementById('statusPill');
  pill.classList.remove('running');
  pill.querySelector('.status-text').textContent = 'Real Data';
  pill.querySelector('.status-dot').style.background = '#10b981';

  return true;
}

// Try to load real results: first from API, then local file, then simulate
async function tryLoadRealResults(scenario) {
  // Try API first
  try {
    const resp = await fetch(`${API_BASE}/results/${scenario}`);
    if (resp.ok) {
      const data = await resp.json();
      return loadRealResults(data);
    }
  } catch (e) { /* API not available */ }

  // Try local file (for dev)
  try {
    const resp = await fetch(`data/${scenario}_latest.json`);
    if (resp.ok) {
      const raw = await resp.json();
      const data = raw.aggregated || raw;
      return loadRealResults(data);
    }
  } catch (e) { /* no local data */ }

  return false;
}

// === Boot: try real data first, fall back to simulation ===
window.addEventListener('DOMContentLoaded', async () => {
  const loaded = await tryLoadRealResults('gradual_ramp');
  if (!loaded) seedScenario('gradual_ramp');
});
