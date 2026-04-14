(() => {
  const STORAGE_KEYS = {
    population: 'animalPopulationRecords',
    vaccination: 'vaccinationRecords',
    complaints: 'farmerComplaints',
    aiHistory: 'aiHistory',
    biosecurity: 'biosecurityAudit',
    external: 'externalRiskFactors',
    overall: 'farmerOverallRisk'
  };

  function readStore(key, fallback = []) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function parseDateValue(value) {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function daysUntil(dateValue) {
    if (!dateValue) return Infinity;
    const millisPerDay = 24 * 60 * 60 * 1000;
    const target = new Date(dateValue);
    const today = new Date();
    target.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return Math.round((target.getTime() - today.getTime()) / millisPerDay);
  }

  function formatDateLabel(date = new Date()) {
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function isSameDay(value) {
    if (!value) return false;

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return false;

    const today = new Date();
    return (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    );
  }

  function ensureExternalFactors() {
    const defaults = {
      temperature: null,
      humidity: null,
      weatherCondition: 'Unavailable',
      governmentAlertLevel: 'Low',
      nearbyInfections: 0,
      notes: 'Live weather unavailable'
    };
    const existing = readStore(STORAGE_KEYS.external, null);
    if (!existing) {
      writeStore(STORAGE_KEYS.external, defaults);
      return defaults;
    }
    return { ...defaults, ...existing };
  }

  function computeBiosecurityRisk() {
    const audit = readStore(STORAGE_KEYS.biosecurity, null);
    const auditDate = audit?.updatedAt || audit?.created_at;

    if (!audit || !audit.responses || !isSameDay(auditDate)) {
      return {
        score: 0,
        label: 'No audit yet',
        reasons: ['Complete today\'s biosecurity audit to activate preventive risk scoring.'],
        raw: null
      };
    }

    const responses = audit.responses;
    const penalties = {
      entry_restricted: 7,
      visitor_log: 4,
      footbath_used: 5,
      vehicles_disinfected: 4,
      daily_clean: 6,
      tools_disinfected: 5,
      has_symptoms: 10,
      health_check_done: 3,
      vax_status: 7,
      vet_consult: 3,
      is_isolated: 8,
      is_quarantined: 6,
      pest_control: 3,
      wildlife_restricted: 3,
      equipment_shared: 4,
      water_test_done: 4,
      feed_mold_free: 4,
      isolation_ready: 4
    };

    let score = 0;
    const reasons = [];

    Object.entries(penalties).forEach(([key, penalty]) => {
      if (responses[key] === false) {
        score += penalty;
      }
    });

    if (responses.has_symptoms === true) {
      reasons.push('animals are showing symptoms during the biosecurity audit');
      score += 8;
    }
    if (responses.is_isolated === false) {
      reasons.push('sick animals are not isolated');
    }
    if (responses.daily_clean === false) {
      reasons.push('daily cleaning and sanitation are weak');
    }
    if (responses.vax_status === false) {
      reasons.push('vaccination status is overdue');
    }
    if (responses.visitor_log === false || responses.entry_restricted === false) {
      reasons.push('farm entry controls are weak');
    }

    return {
      score: clamp(score, 0, 100),
      label: audit.statusText || 'Biosecurity assessed',
      reasons: reasons.length ? reasons : ['biosecurity controls are mostly compliant'],
      raw: audit
    };
  }

  function computeRecordsRisk() {
    const population = readStore(STORAGE_KEYS.population, []);
    const vaccinations = readStore(STORAGE_KEYS.vaccination, []);
    const complaints = readStore(STORAGE_KEYS.complaints, []);

    let score = 0;
    const reasons = [];

    const totalAnimals = population.reduce((sum, record) => sum + toNumber(record.totalAnimals), 0);
    const totalMortality = population.reduce((sum, record) => sum + toNumber(record.mortalityCount), 0);
    const mortalityRatio = totalAnimals > 0 ? (totalMortality / totalAnimals) * 100 : 0;

    if (totalMortality >= 3) {
      score += 25;
      reasons.push(`${totalMortality} recent animal deaths were recorded`);
    } else if (totalMortality > 0) {
      score += 12;
      reasons.push(`recent mortality was recorded in farm records`);
    }

    if (mortalityRatio >= 5) {
      score += 18;
      reasons.push(`mortality ratio is elevated at ${mortalityRatio.toFixed(1)}%`);
    }

    const criticalPopulation = population.filter((record) => String(record.currentHealthState || '').toLowerCase().includes('critical')).length;
    const monitoringPopulation = population.filter((record) => String(record.currentHealthState || '').toLowerCase().includes('monitor')).length;
    if (criticalPopulation) {
      score += criticalPopulation * 8;
      reasons.push(`${criticalPopulation} animal groups are marked critical`);
    }
    if (monitoringPopulation) {
      score += monitoringPopulation * 4;
    }

    const highComplaints = complaints.filter((record) => String(record.urgencyShort || '').toLowerCase() === 'high').length;
    const mediumComplaints = complaints.filter((record) => String(record.urgencyShort || '').toLowerCase() === 'medium').length;
    const unsyncedComplaints = complaints.filter((record) => !record.syncedToFarmer).length;
    if (highComplaints) {
      score += highComplaints * 9;
      reasons.push(`${highComplaints} high-priority complaints are open`);
    }
    if (mediumComplaints) {
      score += mediumComplaints * 4;
    }
    if (unsyncedComplaints >= 3) {
      score += 8;
    }

    const overdueVaccinations = vaccinations.filter((record) => {
      const remainingDays = daysUntil(record.nextDueDate);
      return Number.isFinite(remainingDays) && remainingDays <= 0;
    }).length;
    const upcomingVaccinations = vaccinations.filter((record) => {
      const remainingDays = daysUntil(record.nextDueDate);
      return Number.isFinite(remainingDays) && remainingDays > 0 && remainingDays <= 7;
    }).length;

    if (overdueVaccinations) {
      score += overdueVaccinations * 7;
      reasons.push(`${overdueVaccinations} vaccination schedules are overdue`);
    }
    if (upcomingVaccinations) {
      score += upcomingVaccinations * 2;
    }

    return {
      score: clamp(score, 0, 100),
      reasons: reasons.length ? reasons : ['animal records do not currently show strong warning patterns'],
      summary: {
        totalAnimals,
        totalMortality,
        mortalityRatio,
        criticalPopulation,
        monitoringPopulation,
        highComplaints,
        mediumComplaints,
        overdueVaccinations,
        upcomingVaccinations
      }
    };
  }

  function computeAiRisk() {
    const history = readStore(STORAGE_KEYS.aiHistory, []);
    if (!history.length) {
      return {
        score: 0,
        reasons: ['no AI disease scan has been submitted yet'],
        latest: null
      };
    }

    const sorted = [...history].sort((first, second) => parseDateValue(second.dateISO || second.date) - parseDateValue(first.dateISO || first.date));
    const latest = sorted[0];
    const highest = sorted.reduce((max, entry) => Math.max(max, toNumber(entry.risk)), 0);
    const score = clamp(Math.round(highest * 0.35), 0, 35);
    const reasons = [];

    if (toNumber(latest.risk) >= 80) {
      reasons.push(`AI detected ${latest.disease || 'infection'} with ${latest.risk}% risk`);
    } else if (toNumber(latest.risk) >= 50) {
      reasons.push(`AI scan shows a moderate disease likelihood at ${latest.risk}%`);
    } else {
      reasons.push('latest AI scans are in the low observation range');
    }

    return {
      score,
      reasons,
      latest
    };
  }

  function computeExternalRisk() {
    const external = ensureExternalFactors();
    let score = 0;
    const reasons = [];

    const humidity = toNumber(external.humidity);
    const temperature = toNumber(external.temperature);
    const nearbyInfections = toNumber(external.nearbyInfections);
    const alertLevel = String(external.governmentAlertLevel || 'Low');

    if (humidity >= 85) {
      score += 10;
      reasons.push(`humidity is very high at ${humidity}%`);
    } else if (humidity >= 70) {
      score += 6;
      reasons.push(`humidity is elevated at ${humidity}%`);
    }

    if (temperature >= 38 || temperature <= 10) {
      score += 7;
      reasons.push(`temperature is stressful at ${temperature}°C`);
    } else if (temperature >= 33) {
      score += 4;
      reasons.push(`temperature is warm at ${temperature}°C`);
    }

    if (alertLevel === 'High') {
      score += 10;
      reasons.push('government outbreak alert is high');
    } else if (alertLevel === 'Medium') {
      score += 6;
      reasons.push('government outbreak alert is active');
    }

    if (nearbyInfections >= 3) {
      score += 8;
      reasons.push(`${nearbyInfections} nearby farms reported infections`);
    } else if (nearbyInfections >= 1) {
      score += 4;
      reasons.push(`${nearbyInfections} nearby farm infection alert is active`);
    }

    if (external.notes) {
      reasons.push(external.notes);
    }

    return {
      score: clamp(score, 0, 25),
      reasons: reasons.length ? reasons : ['external conditions are currently stable'],
      raw: external
    };
  }

  function getLevel(score) {
    if (score >= 75) return 'Critical';
    if (score >= 55) return 'High';
    if (score >= 30) return 'Medium';
    return 'Low';
  }

  function getBadgeMeta(level) {
    const meta = {
      Low: { label: 'Low', uiLabel: 'Safe', color: '#15803d', bg: '#dcfce7' },
      Medium: { label: 'Medium', uiLabel: 'Monitor', color: '#b45309', bg: '#fef3c7' },
      High: { label: 'High', uiLabel: 'Take Action', color: '#c2410c', bg: '#fed7aa' },
      Critical: { label: 'Critical', uiLabel: 'Immediate Attention', color: '#b91c1c', bg: '#fee2e2' }
    };
    return meta[level] || meta.Low;
  }

  function computeOverallRisk() {
    const biosecurity = computeBiosecurityRisk();
    const records = computeRecordsRisk();
    const ai = computeAiRisk();
    const external = computeExternalRisk();

    const totalScore = clamp(
      Math.round(biosecurity.score * 0.35 + records.score * 0.30 + ai.score * 1 + external.score * 1),
      0,
      100
    );

    const level = getLevel(totalScore);
    const allReasons = [...biosecurity.reasons, ...records.reasons, ...ai.reasons, ...external.reasons]
      .filter(Boolean)
      .slice(0, 5);

    return {
      score: totalScore,
      level,
      badge: getBadgeMeta(level),
      updatedAt: new Date().toISOString(),
      updatedLabel: formatDateLabel(new Date()),
      factors: {
        biosecurity,
        records,
        ai,
        external
      },
      reasons: allReasons
    };
  }

  async function storeRiskInDB(summary) {
    try {
      const userStr = localStorage.getItem('user');
      if (!userStr) return;
      const user = JSON.parse(userStr);
      if (!user || (!user.id && !user.profileId)) return;
      
      const farmerId = user.profileId || user.id;

      // We will use standard fetch to Supabase REST API so it doesn't break if supabase-js is missing on some pages
      const SUPABASE_URL = 'https://ppksvtcjyvtbcrdncvsm.supabase.co';
      const SUPABASE_KEY = 'sb_publishable_Mz-YMegdeHu08iMHfaIMwQ_61VvS1XE';
      
      const payload = {
        farmer_id: farmerId,
        biosecurity_risk: summary.factors.biosecurity ? summary.factors.biosecurity.score : 0,
        animal_risk: summary.factors.records ? summary.factors.records.score : 0,
        ai_risk: summary.factors.ai ? summary.factors.ai.score : 0,
        external_risk: summary.factors.external ? summary.factors.external.score : 0,
        total_risk: summary.score,
        risk_level: summary.level
      };

      // Check if exists
      const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/farm_risk?farmer_id=eq.${farmerId}&select=id`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      const existing = await checkRes.json();

      if (existing && existing.length > 0) {
        // Update
        await fetch(`${SUPABASE_URL}/rest/v1/farm_risk?id=eq.${existing[0].id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(payload)
        });
      } else {
        // Insert
        await fetch(`${SUPABASE_URL}/rest/v1/farm_risk`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(payload)
        });
      }
    } catch (e) {
      console.error('Error storing risk to farm_risk table:', e);
    }
  }

  function syncOverallRisk() {
    const summary = computeOverallRisk();
    writeStore(STORAGE_KEYS.overall, summary);
    storeRiskInDB(summary);
    return summary;
  }

  window.DigitalFarmRisk = {
    STORAGE_KEYS,
    readStore,
    writeStore,
    ensureExternalFactors,
    computeOverallRisk,
    syncOverallRisk,
    formatDateLabel
  };

  ensureExternalFactors();
  syncOverallRisk();
})();
