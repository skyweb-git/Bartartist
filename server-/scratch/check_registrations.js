const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected!');

    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log('\nCollections in Database:');
    for (const coll of collections) {
      const count = await db.collection(coll.name).countDocuments();
      console.log(`- ${coll.name}: ${count} documents`);
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

run();
