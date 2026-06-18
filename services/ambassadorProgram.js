export const AMBASSADOR_APPLICATION_STATUSES = [
  'pending',
  'interview_scheduled',
  'accepted',
  'rejected',
  'suspended',
];

export const REWARD_RULES = {
  unlockAmount: 500000,
  unlockReward: 2000,
  incrementalAmount: 100000,
  incrementalReward: 100,
  maxRewardPerOrganizer: 5000,
};

export const PROGRESSION_BADGES = [
  { key: 'first_flame', name: 'First Flame', requirement: 1, description: 'First collection influenced' },
  { key: 'rising_star', name: 'Rising Star', requirement: 5, description: '5 collections influenced' },
  { key: 'connector', name: 'The Connector', requirement: 10, description: '10 collections influenced' },
  { key: 'organizer', name: 'The Organizer', requirement: 25, description: '25 collections influenced' },
  { key: 'influencer', name: 'The Influencer', requirement: 50, description: '50 collections influenced' },
  { key: 'game_changer', name: 'The Game Changer', requirement: 100, description: '100 collections influenced' },
  { key: 'titan', name: 'The Titan', requirement: 250, description: '250 collections influenced' },
  { key: 'icon', name: 'The Icon', requirement: 500, description: '500 collections influenced' },
];

export const PRESTIGE_BADGES = [
  { key: 'millionaire_maker', name: 'Millionaire Maker', requirement: 1000000, metric: 'largestCollectionAmount', description: 'Collection exceeds NGN 1M' },
  { key: 'power_broker', name: 'Power Broker', requirement: 5000000, metric: 'largestCollectionAmount', description: 'Collection exceeds NGN 5M' },
  { key: 'kingmaker', name: 'Kingmaker', requirement: 10000000, metric: 'largestCollectionAmount', description: 'Collection exceeds NGN 10M' },
  { key: 'steady_flame', name: 'Steady Flame', requirement: 12, metric: 'weeklyActivityStreak', description: 'Weekly activity for 3 months' },
  { key: 'the_rock', name: 'The Rock', requirement: 24, metric: 'weeklyActivityStreak', description: 'Weekly activity for 6 months' },
  { key: 'campus_hero', name: 'Campus Hero', requirement: 1, metric: 'studentImpactEvents', description: 'Significant student impact' },
  { key: 'lifeline', name: 'Lifeline', requirement: 1000000, metric: 'charityCollectionAmount', description: 'Charity/medical collection raises NGN 1M+' },
  { key: 'trailblazer', name: 'Trailblazer', requirement: 1, metric: 'newCommunitiesOpened', description: 'Opens a new campus/community' },
];

export function normalizeApplicationStatus(status) {
  const normalized = String(status || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return AMBASSADOR_APPLICATION_STATUSES.includes(normalized) ? normalized : null;
}

export function calculateOrganizerReward(processedAmount = 0, paidAmount = 0) {
  const amount = Math.max(0, Number(processedAmount || 0));
  const paid = Math.max(0, Number(paidAmount || 0));
  const unlockProgress = Math.min(100, Math.round((amount / REWARD_RULES.unlockAmount) * 100));

  let generated = 0;
  let locked = REWARD_RULES.unlockReward;

  if (amount >= REWARD_RULES.unlockAmount) {
    const increments = Math.floor((amount - REWARD_RULES.unlockAmount) / REWARD_RULES.incrementalAmount);
    generated = Math.min(
      REWARD_RULES.maxRewardPerOrganizer,
      REWARD_RULES.unlockReward + increments * REWARD_RULES.incrementalReward
    );
    locked = 0;
  }

  const available = Math.max(0, generated - paid);
  const remainingToMax = Math.max(0, REWARD_RULES.maxRewardPerOrganizer - generated);

  return {
    generated,
    paid,
    available,
    locked,
    pending: locked + remainingToMax,
    unlockProgress,
    maxProgress: Math.round((generated / REWARD_RULES.maxRewardPerOrganizer) * 100),
    status: generated >= REWARD_RULES.maxRewardPerOrganizer ? 'maxed' : amount >= REWARD_RULES.unlockAmount ? 'earning' : 'locked',
  };
}

export function calculateBadges(metrics = {}) {
  const collectionsInfluenced = Number(metrics.collectionsInfluenced || 0);
  const progression = PROGRESSION_BADGES.map((badge) => ({
    ...badge,
    type: 'progression',
    earned: collectionsInfluenced >= badge.requirement,
    progress: Math.min(100, Math.round((collectionsInfluenced / badge.requirement) * 100)),
    remaining: Math.max(0, badge.requirement - collectionsInfluenced),
  }));

  const prestige = PRESTIGE_BADGES.map((badge) => {
    const value = Number(metrics[badge.metric] || 0);
    return {
      ...badge,
      type: 'prestige',
      earned: value >= badge.requirement,
      progress: Math.min(100, Math.round((value / badge.requirement) * 100)),
      remaining: Math.max(0, badge.requirement - value),
    };
  });

  return [...progression, ...prestige];
}

export function getAmbassadorRank(collectionsInfluenced = 0) {
  const earned = PROGRESSION_BADGES.filter((badge) => collectionsInfluenced >= badge.requirement).pop();
  return earned?.name || 'Ambassador';
}

function nameWords(fullName = '') {
  return String(fullName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z\s-]/g, '')
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[^a-zA-Z]/g, '').toUpperCase())
    .filter(Boolean);
}

function repeatToLength(value, length) {
  const source = value || 'AMBASSADOR';
  let output = '';
  while (output.length < length) output += source;
  return output.slice(0, length);
}

function rotateLetters(letters, offset) {
  const source = repeatToLength(letters, 6);
  const start = offset % source.length;
  return repeatToLength(source.slice(start) + source.slice(0, start), 6);
}

function uniquePair(seed) {
  const first = Math.floor(seed / 26) % 26;
  const second = seed % 26;
  return `${String.fromCharCode(65 + first)}${String.fromCharCode(65 + second)}`;
}

export function serializeAmbassadorCode(sequenceNumber = 0, fullName = '') {
  const attempt = Math.max(0, Number(sequenceNumber || 0));
  const words = nameWords(fullName);
  const first = words[0] || 'AMBASSADOR';
  const second = words[1] || '';
  const letters = words.join('') || first;

  const preferred = [
    repeatToLength(first, 6),
    repeatToLength(`${first.slice(0, 3)}${second.slice(0, 3)}`, 6),
    repeatToLength(`${first.slice(0, 4)}${second.slice(0, 2)}`, 6),
    repeatToLength(`${first.slice(0, 2)}${second.slice(0, 4)}`, 6),
    rotateLetters(letters, 1),
    rotateLetters(letters, 2),
    rotateLetters(letters, 3),
  ];

  if (attempt < preferred.length) return preferred[attempt];

  const windowAttempt = attempt - preferred.length;
  if (windowAttempt < letters.length) return rotateLetters(letters, windowAttempt);

  return `${repeatToLength(letters, 4)}${uniquePair(windowAttempt - letters.length)}`;
}
