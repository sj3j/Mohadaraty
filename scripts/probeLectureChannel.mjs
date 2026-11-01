import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is missing');
  process.exit(1);
}

const channels = [
  { stage: 'Stage 3 Lectures', id: -1004381841183 },
  { stage: 'Stage 4 Lectures', id: -1004373000001 },
];

for (const ch of channels) {
  console.log(`\nProbing ${ch.stage} (${ch.id})...`);
  try {
    const chatRes = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ch.id })
    });
    const chat = await chatRes.json();
    console.log('getChat:', chat.ok ? { title: chat.result.title, type: chat.result.type } : chat);

    const actionRes = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ch.id, action: 'upload_document' })
    });
    const action = await actionRes.json();
    console.log('sendChatAction (upload_document):', action);
  } catch (err) {
    console.error(`Error probing ${ch.stage}:`, err);
  }
}

