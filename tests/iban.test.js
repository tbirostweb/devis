import {test} from 'node:test';
import assert from 'node:assert/strict';
import {protectIbans} from '../server/iban.js';
test('IBAN referrer and issuer JSON encrypted, reversible and tamper resistant',()=>{
 const key=Buffer.alloc(32,7), input={iban:'FR7630006000011234567890189',issuerSnapshot:{iban:'FR123'},createdAt:new Date()};
 const sealed=protectIbans(input,true,key);
 assert.ok(sealed.iban.startsWith('v1:')); assert.notEqual(sealed.issuerSnapshot.iban,input.issuerSnapshot.iban);
 assert.deepEqual(protectIbans(sealed,false,key),input);
 assert.throws(()=>protectIbans(sealed,false,Buffer.alloc(32,8)));
 assert.deepEqual(protectIbans(sealed,true,key),sealed);
});
test('No missing/default key; Prisma scalar set encrypted',()=>{
 const old=process.env.IBAN_ENCRYPTION_KEY; delete process.env.IBAN_ENCRYPTION_KEY;
 try {assert.throws(()=>protectIbans({iban:'FR123'},true),/IBAN_ENCRYPTION_KEY/);} finally {if(old!==undefined)process.env.IBAN_ENCRYPTION_KEY=old;}
 const sealed=protectIbans({iban:{set:'FR123'}},true,Buffer.alloc(32,4)); assert.ok(sealed.iban.set.startsWith('v1:'));
});
