import fetch from 'node-fetch';

async function test() {
  try {
    const res = await fetch('http://localhost:5173/api/announcements/test_post/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍', hasReacted: false })
    });
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response:", text);
  } catch (err) {
    console.error(err);
  }
}
test();
