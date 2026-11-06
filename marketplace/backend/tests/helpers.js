'use strict';
const request = require('supertest');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

// Build a valid SA ID number for a given date of birth.
function saId(yymmdd, seq = '5009') {
  const body = `${yymmdd}${seq}08`;
  for (let c = 0; c <= 9; c++) {
    const id = body + c;
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      let d = Number(id[12 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return id;
  }
  throw new Error('unreachable');
}

async function setup() {
  const db = open(':memory:');
  await seed(db);
  const app = createApp(db);
  const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'password123' })).body.token;
  return { db, app, login, api: (token) => ({
    get: (u) => request(app).get(u).set('Authorization', `Bearer ${token}`),
    post: (u, b) => request(app).post(u).set('Authorization', `Bearer ${token}`).send(b || {}),
    patch: (u, b) => request(app).patch(u).set('Authorization', `Bearer ${token}`).send(b || {}),
    put: (u, b) => request(app).put(u).set('Authorization', `Bearer ${token}`).send(b || {}),
    delete: (u) => request(app).delete(u).set('Authorization', `Bearer ${token}`),
  }) };
}

module.exports = { setup, saId };
