import fs from 'node:fs';
import { assignMcqCompetitionRanks } from '../src/lib/mcqLeaderboard';

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

const ranked = assignMcqCompetitionRanks([
  { userId: 'a', mcqLeaderboardScore: 300, accuracy: 60 },
  { userId: 'b', mcqLeaderboardScore: 200, accuracy: 95 },
  { userId: 'c', mcqLeaderboardScore: 200, accuracy: 80 },
  { userId: 'd', mcqLeaderboardScore: 100, accuracy: 100 },
]);
check('equal points share competition rank', ranked.map(r => r._rank).join(',') === '1,2,2,4');

const boardSource = fs.readFileSync('src/components/LeaderboardTab.tsx', 'utf8');
const profileSource = fs.readFileSync('src/components/ProfileScreen.tsx', 'utf8');
check('live board uses onSnapshot', boardSource.includes('onSnapshot('));
check('board orders by authoritative points', boardSource.includes("orderBy('mcqLeaderboardScore', 'desc')"));
check('accuracy and user ID are deterministic tie breakers',
  boardSource.includes("orderBy('accuracy', 'desc')") && boardSource.includes("orderBy('userId', 'asc')"));
check('leaderboard has no legacy userMCQStats fallback', !boardSource.includes("collection(db, 'userMCQStats')"));
check('profile rank has no legacy userMCQStats fallback', !profileSource.includes("collection(db, 'userMCQStats')"));

console.log(`\n${failed ? 'FAILED' : 'OK'} (${failed} failures)`);
process.exit(failed ? 1 : 0);
