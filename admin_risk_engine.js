const AdminRiskEngine = (() => {

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  // =========================
  // FETCH DATA FROM DB
  // =========================
  async function fetchAllData(supabaseClient) {
    const [animals, complaints] = await Promise.all([
      supabaseClient.from('animals').select('*'),
      fetch("http://localhost:5000/api/v1/complaints").then(res => res.json())
    ]);

    return {
      animals: animals.data || [],
      complaints: complaints.data || []
    };
  }

  // =========================
  // GROUP BY ZONE
  // =========================
  function groupByZone(farmers, animals, complaints) {
    const zones = {};

    farmers.forEach(farmer => {
      const key = `${farmer.state}-${farmer.district}-${farmer.village}`;

      if (!zones[key]) {
        zones[key] = {
          farmers: [],
          animals: [],
          complaints: []
        };
      }

      zones[key].farmers.push(farmer);
    });

    zonesKeys = Object.keys(zones);

    zonesKeys.forEach(key => {
      const farmerIds = zones[key].farmers.map(f => f.id);

      zones[key].animals = animals.filter(a => farmerIds.includes(a.farmer_id));
      zones[key].complaints = complaints.filter(c => farmerIds.includes(c.farmer_id));
    });

    return zones;
  }

  // =========================
  // COMPUTE RISK PER ZONE
  // =========================
  function computeZoneRisk(zone) {

    let score = 0;
    let reasons = [];

    // 🔴 Mortality Risk
    const totalAnimals = zone.animals.reduce((sum, a) => sum + Number(a.total_animals || 0), 0);
    const totalDeaths = zone.animals.reduce((sum, a) => sum + Number(a.mortality_count || 0), 0);

    const mortalityRate = totalAnimals > 0 ? (totalDeaths / totalAnimals) * 100 : 0;

    if (totalDeaths > 5) {
      score += 25;
      reasons.push("high animal deaths in zone");
    }

    if (mortalityRate > 5) {
      score += 20;
      reasons.push(`mortality rate ${mortalityRate.toFixed(1)}%`);
    }

    // 🔴 Complaint Risk
    const highComplaints = zone.complaints.filter(c =>
      String(c.urgency_level || '').toLowerCase() === 'high'
    ).length;

    if (highComplaints > 0) {
      score += highComplaints * 10;
      reasons.push(`${highComplaints} high complaints`);
    }

    // 🔴 Outbreak Indicator
    if (highComplaints >= 3) {
      score += 15;
      reasons.push("possible outbreak cluster");
    }

    return {
      score: clamp(score, 0, 100),
      reasons
    };
  }

  // =========================
  // GLOBAL RISK
  // =========================
  function computeGlobalRisk(zones) {

    const zoneEntries = Object.entries(zones);

    let highRiskZones = 0;

    const zoneResults = zoneEntries.map(([key, zone]) => {
      const result = computeZoneRisk(zone);

      if (result.score >= 60) highRiskZones++;

      return { key, ...result };
    });

    return {
      zones: zoneResults,
      highRiskZones
    };
  }

  // =========================
  // MAIN FUNCTION
  // =========================
  async function run(supabaseClient, farmers) {

    const { animals, complaints } = await fetchAllData(supabaseClient);

    const zones = groupByZone(farmers, animals, complaints);

    const result = computeGlobalRisk(zones);

    return result;
  }

  return {
    run
  };

})();