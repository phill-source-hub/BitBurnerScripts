/**
 * corporation.js
 * Version: 1.0.0
 *
 * Corporation automation for PhlanxOS. Requires SF3 or BN3.
 *
 * Behaviour:
 *   Manages the full corporation lifecycle via a phase state machine.
 *   Each phase has a completion condition; once met, the script advances.
 *
 *   Phase 0: CREATE
 *     - Create corporation (selfFund=$150B, or free/seeded in BN3)
 *     - Create Agriculture division
 *     - Expand to all 6 cities, buy warehouses
 *
 *   Phase 1: SETUP
 *     - Hire 3 employees in each office, assign jobs
 *     - Enable Smart Supply
 *     - Set sell orders: Plants → MAX/MP, Food → MAX/MP
 *     - Buy initial materials (Hardware 125, AI Cores 75, Real Estate 27000)
 *     - Upgrade Smart Storage (warehouse upgrade) to size 300
 *
 *   Phase 2: ROUND1
 *     - Upgrade office sizes to 9 per city
 *     - Buy Wilson Analytics, Nuoptimal Nootropic, Speech Processor Implants
 *     - Wait for investment offer >= ROUND1_TARGET ($210B)
 *     - Accept round 1 investment
 *
 *   Phase 3: EXPAND
 *     - Upgrade all offices to 9 employees, balance job assignments
 *     - Buy more materials (target: Hardware 2800, Robots 96, AI Cores 2520, RE 146400)
 *     - Upgrade warehouses to 2000
 *     - Buy more upgrades
 *     - Wait for investment offer >= ROUND2_TARGET ($5T)
 *     - Accept round 2
 *
 *   Phase 4: PRODUCTS
 *     - Create product division (Robotics or Computer Hardware)
 *     - Make products with maximum invest budget
 *     - Discontinue lowest-rated product when at product limit
 *     - Log when ready for IPO
 *
 * Gate:
 *   All corporation calls use bracket notation (ns['corporation']['fn']()).
 *   Script costs ~2 GB. If no corp API, first call throws — sleeps and retries.
 *
 * Changelog:
 *   v1.0.0 - Initial version.
 *
 * Flags:
 *   --help            Show usage
 *   --interval N      Cycle interval in seconds (default: 10)
 *   --once            Single cycle and exit
 *   --no-invest       Never auto-accept investment offers (log only)
 *   --self-fund       Use selfFund=true for corp creation ($150B cost)
 *   --phase N         Force start from a specific phase (0-4)
 *
 * Dependencies:
 *   None. Standalone — no imports.
 *
 * RAM: ~2 GB (all corp calls bracket notation)
 */

const VERSION = '1.1.0';

const CORP_NAME      = 'PhlanxCorp';
const DIV_AGRI       = 'PhlanxAgri';
const DIV_PRODUCT    = 'PhlanxTech';

const CITIES = ['Sector-12', 'Aevum', 'Volhaven', 'Chongqing', 'New Tokyo', 'Ishima'];

// Investment round targets
const ROUND1_TARGET  = 210e9;                                                        // $210B each ($420B total)
const ROUND2_TARGET  = 5e12;                                                         // $5T each ($10T total)

// Material targets per city per phase
const MAT_PHASE1 = { 'Hardware': 125, 'AI Cores': 75, 'Real Estate': 27000 };
const MAT_PHASE3 = { 'Hardware': 2800, 'Robots': 96, 'AI Cores': 2520, 'Real Estate': 146400 };

// Key upgrades and their target levels
const UPGRADES_PHASE2 = [
    { name: 'Wilson Analytics',               level: 2 },
    { name: 'Nuoptimal Nootropic Injector Implants', level: 2 },
    { name: 'Speech Processor Implants',      level: 2 },
    { name: 'Neural Accelerators',            level: 2 },
    { name: 'FocusWires',                     level: 2 },
    { name: 'ABC SalesBots',                  level: 2 },
    { name: 'Project Insight',                level: 2 },
];

const UPGRADES_PHASE3 = [
    { name: 'Wilson Analytics',               level: 10 },
    { name: 'Nuoptimal Nootropic Injector Implants', level: 10 },
    { name: 'Speech Processor Implants',      level: 10 },
    { name: 'Neural Accelerators',            level: 10 },
    { name: 'FocusWires',                     level: 10 },
    { name: 'ABC SalesBots',                  level: 10 },
    { name: 'Project Insight',                level: 10 },
    { name: 'Smart Factories',                level: 10 },
    { name: 'Smart Storage',                  level: 10 },
    { name: 'DreamSense',                     level: 5  },
];

// Job assignments per employee count
const JOB_ASSIGNMENTS = {
    3:  { 'Operations': 1, 'Engineer': 1, 'Business': 1 },
    9:  { 'Operations': 2, 'Engineer': 2, 'Business': 2, 'Management': 1, 'Research & Development': 2 },
    30: { 'Operations': 6, 'Engineer': 9, 'Business': 5, 'Management': 5, 'Research & Development': 5 },
};


// =============================================================================
// Entry point
// =============================================================================

export async function main(ns) {
    const flags = ns.flags([
        ['help',        false],
        ['interval',    10],
        ['once',        false],
        ['no-invest',   false],
        ['self-fund',   false],
        ['phase',       -1],
    ]);

    if (flags.help) {
        ns.tprint('=== corporation.js v' + VERSION + ' ===');
        ns.tprint('Purpose: Corporation automation — agriculture → investment → products.');
        ns.tprint('Usage:   run /scripts/corporation.js [--self-fund] [--no-invest]');
        ns.tprint('Flags:');
        ns.tprint('  --self-fund   Create corp with $150B self-fund (default: BN3 seed)');
        ns.tprint('  --no-invest   Log investment offers but do not auto-accept');
        ns.tprint('  --phase N     Force start phase (0-4, for debugging)');
        ns.tprint('  --interval N  Cycle interval seconds (default: 10)');
        ns.tprint('  --once        Single cycle and exit');
        return;
    }

    ns.disableLog('ALL');
    ns.print('=== corporation.js v' + VERSION + ' | interval=' + flags.interval + 's ===');

    const INTERVAL = flags.interval * 1000;

    do {
        const ok = runCycle(ns, flags);
        if (!ok) {
            ns.print('[CORP] No corporation API access — sleeping ' + flags.interval + 's, will retry');
        }
        if (!flags.once) await ns.sleep(INTERVAL);
    } while (!flags.once);
}


// =============================================================================
// Main cycle — state machine
// =============================================================================

function runCycle(ns, flags) {
    const corp = ns['corporation'];                                                  // Bracket alias

    // Runtime gate
    try {
        corp['hasCorporation']();
    } catch (_) {
        return false;
    }

    // Determine current phase
    const hasCorp = corp['hasCorporation']();
    if (!hasCorp) {
        phaseCreate(ns, corp, flags);
        return true;
    }

    const corpData = corp['getCorporation']();
    const divNames = corpData.divisions;
    const hasAgri  = divNames.includes(DIV_AGRI);

    if (!hasAgri) {
        // Corp exists but Agriculture not created yet
        createAgriDivision(ns, corp);
        return true;
    }

    // Determine phase from corp state
    let phase = flags.phase >= 0 ? flags.phase : detectPhase(ns, corp, corpData);

    ns.print('[CORP] Phase: ' + phase + ' | Funds: $' + ns.format.number(corpData.funds) + ' | Revenue: $' + ns.format.number(corpData.revenue) + '/s');

    switch (phase) {
        case 0: phaseCreate(ns, corp, flags);   break;
        case 1: phaseSetup(ns, corp, flags);    break;
        case 2: phaseRound1(ns, corp, flags);   break;
        case 3: phaseExpand(ns, corp, flags);   break;
        case 4: phaseProducts(ns, corp, flags); break;
        default: ns.print('[CORP] Phase ' + phase + ' — monitoring only'); break;
    }

    return true;
}


// =============================================================================
// Phase detection
// =============================================================================

function detectPhase(ns, corp, corpData) {
    const divNames = corpData.divisions;
    const hasAgri  = divNames.includes(DIV_AGRI);

    if (!hasAgri) return 0;

    // Check setup complete: warehouses in all cities + employees hired
    try {
        const agri        = corp['getDivision'](DIV_AGRI);
        const citiesSetup = agri.cities;

        if (citiesSetup.length < 6) return 1;

        // Check employee count in each city
        let minEmployees = Infinity;
        for (const city of CITIES) {
            try {
                const office = corp['getOffice'](DIV_AGRI, city);
                if (office.numEmployees < minEmployees) minEmployees = office.numEmployees;
            } catch (_) {}
        }

        if (minEmployees < 3) return 1;

        // Check if we've had round 1 (fund level jumped significantly)
        if (corpData.totalAssets < 400e9) return 2;
        if (corpData.totalAssets < 10e12) return 3;

        return 4;
    } catch (_) {
        return 1;
    }
}


// =============================================================================
// Phase 0: Create corporation and Agriculture division
// =============================================================================

function phaseCreate(ns, corp, flags) {
    const hasCorp = corp['hasCorporation']();

    if (!hasCorp) {
        try {
            const selfFund = flags['self-fund'];
            const ok = corp['createCorporation'](CORP_NAME, selfFund);
            if (ok) {
                ns.tprint('[CORP] Created corporation: ' + CORP_NAME + (selfFund ? ' (self-funded $150B)' : ' (BN3 seed)'));
            } else {
                ns.print('[CORP] Cannot create corp yet — need $150B or BN3.');
                return;
            }
        } catch (e) {
            ns.print('[CORP] Corp creation error: ' + e);
            return;
        }
    }

    createAgriDivision(ns, corp);
}

function createAgriDivision(ns, corp) {
    try {
        corp['expandIndustry']('Agriculture', DIV_AGRI);
        ns.tprint('[CORP] Created division: ' + DIV_AGRI + ' (Agriculture)');
    } catch (_) {}

    // Expand to all cities
    for (const city of CITIES) {
        try {
            corp['expandCity'](DIV_AGRI, city);
        } catch (_) {}

        try {
            corp['purchaseWarehouse'](DIV_AGRI, city);
        } catch (_) {}
    }

    ns.tprint('[CORP] Agriculture expanded to all cities.');
}


// =============================================================================
// Phase 1: Basic setup
// =============================================================================

function phaseSetup(ns, corp, flags) {
    // Hire employees and assign jobs in all cities
    for (const city of CITIES) {
        ensureOfficeSize(ns, corp, DIV_AGRI, city, 3);
        assignJobs(ns, corp, DIV_AGRI, city, 3);

        // Enable Smart Supply and sell orders
        try { corp['setSmartSupply'](DIV_AGRI, city, true); } catch (_) {}
        try { corp['sellMaterial'](DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch (_) {}
        try { corp['sellMaterial'](DIV_AGRI, city, 'Food',   'MAX', 'MP'); } catch (_) {}
        // Stop buying raw materials that aren't input to Agriculture
        try { corp['buyMaterial'](DIV_AGRI, city, 'Water', 0); } catch (_) {}
    }

    // Smart Storage upgrade — warehouse size
    try {
        const storageLevel = corp['getUpgradeLevel']('Smart Storage');
        if (storageLevel < 5) {
            purchaseUpgradeTo(ns, corp, 'Smart Storage', 5);
        }
    } catch (_) {}

    // Buy initial materials — only buy, don't set continuous buy order
    buyMaterialsToTarget(ns, corp, DIV_AGRI, MAT_PHASE1);

    ns.print('[CORP] Phase 1: Setup in progress — hiring, selling, materials...');
}


// =============================================================================
// Phase 2: Round 1 investment
// =============================================================================

function phaseRound1(ns, corp, flags) {
    // Upgrade offices to 9
    for (const city of CITIES) {
        ensureOfficeSize(ns, corp, DIV_AGRI, city, 9);
        assignJobs(ns, corp, DIV_AGRI, city, 9);
    }

    // Buy Phase 2 upgrades
    for (const upg of UPGRADES_PHASE2) {
        purchaseUpgradeTo(ns, corp, upg.name, upg.level);
    }

    // Check investment offer
    try {
        const offer = corp['getInvestmentOffer']();
        ns.print('[CORP] Investment offer: $' + ns.format.number(offer.amount) + ' | Round: ' + offer.round + ' | Target: $' + ns.format.number(ROUND1_TARGET));

        if (offer.round === 1 && offer.amount >= ROUND1_TARGET) {
            if (!flags['no-invest']) {
                corp['acceptInvestmentOffer']();
                ns.tprint('[CORP] Accepted round 1 investment: $' + ns.format.number(offer.amount));
            } else {
                ns.tprint('[CORP] Round 1 ready ($' + ns.format.number(offer.amount) + ') — run without --no-invest to accept');
            }
        }
    } catch (_) {}
}


// =============================================================================
// Phase 3: Expand after round 1
// =============================================================================

function phaseExpand(ns, corp, flags) {
    // Upgrade offices to 30
    for (const city of CITIES) {
        ensureOfficeSize(ns, corp, DIV_AGRI, city, 30);
        assignJobs(ns, corp, DIV_AGRI, city, 30);
    }

    // Buy Phase 3 upgrades
    for (const upg of UPGRADES_PHASE3) {
        purchaseUpgradeTo(ns, corp, upg.name, upg.level);
    }

    // Upgrade warehouses to 2000
    for (const city of CITIES) {
        try {
            const wh = corp['getWarehouse'](DIV_AGRI, city);
            if (wh.size < 2000) {
                // upgradeWarehouse takes n = number of times to upgrade
                corp['upgradeWarehouse'](DIV_AGRI, city, 1);
            }
        } catch (_) {}
    }

    // Buy Phase 3 materials
    buyMaterialsToTarget(ns, corp, DIV_AGRI, MAT_PHASE3);

    // Check investment offer round 2
    try {
        const offer = corp['getInvestmentOffer']();
        ns.print('[CORP] Investment offer: $' + ns.format.number(offer.amount) + ' | Round: ' + offer.round + ' | Target: $' + ns.format.number(ROUND2_TARGET));

        if (offer.round === 2 && offer.amount >= ROUND2_TARGET) {
            if (!flags['no-invest']) {
                corp['acceptInvestmentOffer']();
                ns.tprint('[CORP] Accepted round 2 investment: $' + ns.format.number(offer.amount));
            } else {
                ns.tprint('[CORP] Round 2 ready ($' + ns.format.number(offer.amount) + ') — run without --no-invest to accept');
            }
        }
    } catch (_) {}
}


// =============================================================================
// Phase 4: Products division
// =============================================================================

function phaseProducts(ns, corp, flags) {
    const corpData = corp['getCorporation']();
    const divNames = corpData.divisions;

    // Create product division if needed
    if (!divNames.includes(DIV_PRODUCT)) {
        try {
            corp['expandIndustry']('Computer Hardware', DIV_PRODUCT);
            ns.tprint('[CORP] Created product division: ' + DIV_PRODUCT);
        } catch (e) {
            ns.print('[CORP] Could not create product division: ' + e);
            return;
        }
    }

    // Expand product division to all cities (products sell in every city we operate)
    for (const city of CITIES) {
        try { corp['expandCity'](DIV_PRODUCT, city); } catch (_) {}
        try { corp['purchaseWarehouse'](DIV_PRODUCT, city); } catch (_) {}
        ensureOfficeSize(ns, corp, DIV_PRODUCT, city, 3);
        assignJobs(ns, corp, DIV_PRODUCT, city, 3);
    }

    // Make products
    try {
        const div     = corp['getDivision'](DIV_PRODUCT);
        const funds   = corpData.funds;
        const invest  = funds * 0.01;                                               // Invest 1% of corp funds per product

        const products = div.products;
        const maxProd  = getMaxProducts(ns, corp);

        if (products.length < maxProd) {
            const prodName = 'Product-v' + (products.length + 1);
            corp['makeProduct'](DIV_PRODUCT, 'Sector-12', prodName, invest, invest);
            ns.tprint('[CORP] Started making: ' + prodName + ' ($' + ns.format.number(invest * 2) + ' invest)');
        }

        // Set sell orders for all completed products in all cities
        for (const prodName of div.products) {
            try {
                const prod = corp['getProduct'](DIV_PRODUCT, 'Sector-12', prodName);
                if (prod.developmentProgress < 100) continue;
                // 'MAX' amount, 'MP*1' price — market price multiplier (auto-adjusts to demand)
                corp['sellProduct'](DIV_PRODUCT, 'Sector-12', prodName, 'MAX', 'MP*2', true);  // MP*2 = 2x market price; raise manually if demand allows
            } catch (_) {}
        }

        if (products.length >= maxProd) {
            // At product cap — discontinue lowest-rated completed product
            discontinueWorstProduct(ns, corp);
        }
    } catch (e) {
        ns.print('[CORP] Product phase error: ' + e);
    }

    const offer = getOfferSafe(ns, corp);
    if (offer) {
        ns.print('[CORP] Current investment offer: $' + ns.format.number(offer.amount) + ' (round ' + offer.round + ')');
        if (offer.round > 2) {
            ns.tprint('[CORP] Ready for IPO when desired. Current offer: $' + ns.format.number(offer.amount));
        }
    }
}

function getMaxProducts(ns, corp) {
    try {
        const constants = corp['getConstants']();
        return constants.maxProductsInDivision || 3;
    } catch (_) {
        return 3;
    }
}

function discontinueWorstProduct(ns, corp) {
    try {
        const div = corp['getDivision'](DIV_PRODUCT);
        let worstName  = null;
        let worstRating = Infinity;

        for (const prodName of div.products) {
            try {
                const prod = corp['getProduct'](DIV_PRODUCT, 'Sector-12', prodName);
                if (prod.developmentProgress < 100) continue;                       // Skip in-progress
                if (prod.rating < worstRating) {
                    worstRating = prod.rating;
                    worstName   = prodName;
                }
            } catch (_) {}
        }

        if (worstName) {
            corp['discontinueProduct'](DIV_PRODUCT, worstName);
            ns.tprint('[CORP] Discontinued: ' + worstName + ' (rating ' + worstRating.toFixed(0) + ')');
        }
    } catch (_) {}
}


// =============================================================================
// Shared helpers
// =============================================================================

function ensureOfficeSize(ns, corp, division, city, target) {
    try {
        const office = corp['getOffice'](division, city);
        const current = office.size;
        if (current < target) {
            corp['upgradeOfficeSize'](division, city, target - current);
        }
        // Hire up to size
        const afterOffice = corp['getOffice'](division, city);
        while (afterOffice.numEmployees < afterOffice.size) {
            corp['hireEmployee'](division, city, 'Unassigned');
        }
    } catch (_) {}
}

function assignJobs(ns, corp, division, city, employeeCount) {
    const template = JOB_ASSIGNMENTS[employeeCount] || JOB_ASSIGNMENTS[3];

    for (const [job, count] of Object.entries(template)) {
        try {
            corp['setAutoJobAssignment'](division, city, job, count);
        } catch (_) {}
    }
}

function purchaseUpgradeTo(ns, corp, name, targetLevel) {
    try {
        let current = corp['getUpgradeLevel'](name);
        while (current < targetLevel) {
            const cost    = corp['getUpgradeLevelCost'](name);
            const corpFunds = corp['getCorporation']().funds;
            if (corpFunds < cost) break;                                            // Can't afford

            corp['purchaseUpgrade'](name);
            current++;
        }
    } catch (_) {}
}

/**
 * Buy materials up to target amounts using one-time buy orders.
 * Sets buy amount each cycle based on remaining gap.
 */
function buyMaterialsToTarget(ns, corp, division, targets) {
    for (const city of CITIES) {
        for (const [material, targetAmt] of Object.entries(targets)) {
            try {
                const mat = corp['getMaterial'](division, city, material);
                const gap = targetAmt - mat.stored;
                if (gap <= 0) {
                    corp['buyMaterial'](division, city, material, 0);              // Cancel any pending buy
                    continue;
                }
                // Buy at rate of gap/10 per tick (10s game ticks) to reach target in ~10 ticks
                corp['buyMaterial'](division, city, material, gap / 10);
            } catch (_) {}
        }
    }
}

function getOfferSafe(ns, corp) {
    try { return corp['getInvestmentOffer'](); } catch (_) { return null; }
}
