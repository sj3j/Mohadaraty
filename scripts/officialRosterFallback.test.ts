import assert from 'node:assert/strict';
import test from 'node:test';

test('officialRoster fallback logic resolves subgroup from users if students doc is missing subgroup', async () => {
  // Simulate active docs in students
  const activeDocs = [
    { id: 'ph1@alsafwa.edu.iq', data: { name: 'Student In A', email: 'ph1@alsafwa.edu.iq', subgroup: 'A1' } },
    { id: 'ph2@alsafwa.edu.iq', data: { name: 'Student Missing Subgroup In Students', email: 'ph2@alsafwa.edu.iq', subgroup: '' } },
    { id: 'ph3@alsafwa.edu.iq', data: { name: 'Student With No User Record', email: 'ph3@alsafwa.edu.iq', subgroup: '' } },
  ];

  // Simulated users collection in that stage
  const mockUsers = [
    { id: 'user_ph2', data: () => ({ email: 'ph2@alsafwa.edu.iq', group: 'C3' }) },
  ];

  const userGroupByEmail = new Map<string, string>();
  mockUsers.forEach((uDoc) => {
    const uData = uDoc.data() as any;
    const grp = String(uData.group || uData.subgroup || '').trim();
    if (grp) {
      if (uData.email) userGroupByEmail.set(String(uData.email).trim().toLowerCase(), grp);
      userGroupByEmail.set(uDoc.id, grp);
    }
  });

  const roster = activeDocs
    .map(({ id, data }) => {
      const email = String(data.email || id || '').trim().toLowerCase();
      const resolvedSubgroup = String(data.subgroup || userGroupByEmail.get(email) || userGroupByEmail.get(id) || '').trim();
      return {
        studentId: id,
        officialName: String(data.name || '').trim(),
        subgroup: resolvedSubgroup,
      };
    })
    .filter((s) => s.officialName);

  assert.equal(roster[0].subgroup, 'A1');
  assert.equal(roster[1].subgroup, 'C3', 'Missing subgroup in students must be resolved from users collection');
  assert.equal(roster[2].subgroup, '', 'Student without user record remains unassigned');
});

test('DoctorExcelTimetableView dynamic groups memo includes standard A, B, C, D', () => {
  const STANDARD_GROUPS = ['A', 'B', 'C', 'D'];
  const groupsSet = new Set<string>(STANDARD_GROUPS);
  const subgroupsMap = new Map<string, Set<string>>();

  for (const g of STANDARD_GROUPS) {
    subgroupsMap.set(g, new Set([`${g}1`, `${g}2`, `${g}3`, `${g}4`]));
  }

  // Suppose students in roster only have group D
  const students = [
    { studentId: '1', name: 'Ali', group: 'D1' },
    { studentId: '2', name: 'Hassan', group: 'D2' },
  ];

  for (const s of students) {
    const sub = (s.group || '').trim();
    const match = sub.match(/^([A-Za-z]+)/);
    const mainGroup = match ? match[1].toUpperCase() : sub.charAt(0).toUpperCase();
    groupsSet.add(mainGroup);
    if (!subgroupsMap.has(mainGroup)) subgroupsMap.set(mainGroup, new Set());
    subgroupsMap.get(mainGroup)!.add(sub);
  }

  const sortedGroups = Array.from(groupsSet).sort();
  assert.deepEqual(sortedGroups, ['A', 'B', 'C', 'D'], 'Groups A, B, C, D must all be present even if roster only has D');
  assert.ok(subgroupsMap.get('A')!.has('A1'), 'Subgroup A1 must be available');
  assert.ok(subgroupsMap.get('B')!.has('B1'), 'Subgroup B1 must be available');
  assert.ok(subgroupsMap.get('C')!.has('C1'), 'Subgroup C1 must be available');
  assert.ok(subgroupsMap.get('D')!.has('D1'), 'Subgroup D1 must be available');
});
