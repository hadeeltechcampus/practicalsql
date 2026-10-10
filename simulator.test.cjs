const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const core = vm.createContext({});
vm.runInContext(script.split('let exercise = new AccountExercise();')[0] + '\nthis.Engine = AccountExercise;', core);
const schema = 'CREATE TABLE Accounts (Acc_no INT PRIMARY KEY, Acc_name VARCHAR(50), Balance DECIMAL(10,2));';
const init = schema + "INSERT INTO Accounts VALUES (1, 'First', 1000.00); INSERT INTO Accounts VALUES (2, 'Second', 500.00);";
const debit = 'UPDATE Accounts SET Balance = Balance - 100 WHERE Acc_no = 1;';
const credit = 'UPDATE Accounts SET Balance = Balance + 100 WHERE Acc_no = 2;';
const transfer = 'BEGIN TRANSACTION;' + debit + credit;
const fresh = () => { const s = new core.Engine(); s.execute(init); return s; };
const balances = s => Array.from(s.db.accounts, a => a.cents);

test('original five-step assignment: rollback then repeat and commit', () => {
    const s = fresh(); s.execute(transfer); assert.deepEqual(balances(s), [90000,60000]);
    s.execute('ROLLBACK;'); assert.deepEqual(balances(s), [100000,50000]);
    s.execute(transfer + 'COMMIT;'); assert.deepEqual(balances(s), [90000,60000]);
    assert.deepEqual(Array.from(s.progress), [true,true,true,true,true]); assert.equal(s.total(),150000);
});
test('same operations across separate Execute clicks retain transaction state', () => {
    const s = fresh(); s.execute('BEGIN TRANSACTION;'); s.execute(debit); s.execute(credit);
    assert.equal(s.active,true); s.execute('ROLLBACK;'); assert.equal(s.active,false);
    assert.deepEqual(balances(s),[100000,50000]);
});
test('invalid schema does not create a table', () => {
    const s = new core.Engine(); s.execute('CREATE TABLE Accounts (nonsense);');
    assert.equal(s.db.created,false); assert.equal(s.progress[0],false);
    s.execute("INSERT INTO Accounts VALUES (1, 'No table', 10);"); assert.equal(s.db.accounts.length,0);
});
test('duplicate CREATE does not erase existing data or run later commands', () => {
    const s = fresh(); s.execute(schema + "INSERT INTO Accounts VALUES (3, 'Skipped', 1);");
    assert.deepEqual(balances(s),[100000,50000]); assert.equal(s.db.accounts.length,2);
});
test('wrong primary key, type or column names are rejected', () => {
    for (const invalid of [schema.replace('PRIMARY KEY',''),schema.replace('VARCHAR(50)','VARCHAR(5)'),schema.replace('Balance','Other'),schema.replace('DECIMAL(10,2)','INT')]) {
        const s = new core.Engine(); s.execute(invalid); assert.equal(s.db.created,false);
    }
});
test('missing recipient blocks COMMIT until explicit rollback', () => {
    const s = fresh(); s.execute('BEGIN TRANSACTION;' + debit + credit.replace('= 2','= 999') + 'COMMIT;');
    assert.equal(s.failed,true); assert.equal(s.active,true);
    s.execute('COMMIT;'); assert.equal(s.active,true);
    assert.deepEqual(Array.from(s.record().db.accounts,a=>a.cents),[100000,50000]);
    s.execute('ROLLBACK;'); assert.deepEqual(balances(s),[100000,50000]); assert.equal(s.failed,false);
});
test('incomplete transfer cannot be committed', () => {
    const s = fresh(); s.execute('BEGIN TRANSACTION;' + debit + 'COMMIT;');
    assert.equal(s.active,true); assert.equal(s.failed,true); s.execute('ROLLBACK;');
    assert.deepEqual(balances(s),[100000,50000]);
});
test('mismatched amount or same account cannot complete transfer', () => {
    for (const wrong of [credit.replace('+ 100','+ 99'),credit.replace('= 2','= 1')]) {
        const s = fresh(); s.execute('BEGIN TRANSACTION;' + debit + wrong + 'COMMIT;');
        assert.equal(s.failed,true); assert.equal(s.progress[2],false); s.execute('ROLLBACK;');
        assert.deepEqual(balances(s),[100000,50000]);
    }
});
test('overdraft does not change the account', () => {
    const s = fresh(); s.execute('BEGIN TRANSACTION;' + debit.replace('- 100','- 1001'));
    assert.deepEqual(balances(s),[100000,50000]); assert.equal(s.failed,true);
});
test('updates outside transaction are rejected', () => {
    const s = fresh(); s.execute(debit); assert.deepEqual(balances(s),[100000,50000]);
});
test('duplicate account key rejected', () => {
    const s = fresh(); s.execute("INSERT INTO Accounts VALUES (1, 'Duplicate', 1);"); assert.equal(s.db.accounts.length,2);
});
test('invalid values rejected without partial numeric parsing', () => {
    for (const values of ["1abc, 'Name', 1","3, 'Name', 1.234","3, 'Name', -1","3, 'Name', 100000000","2147483648, 'Name', 1","3, '', 1","3, 'Name', 1, 2","3, '"+'a'.repeat(51)+"', 1"]) {
        const s = fresh(); s.execute('INSERT INTO Accounts VALUES ('+values+');'); assert.equal(s.db.accounts.length,2,values);
    }
});
test('strings can contain escaped quotes, commas, semicolons and comment markers', () => {
    const s = fresh(); s.execute("INSERT INTO Accounts VALUES (3, 'O''Brien, A;--/*test*/', 0.10); -- comment\n SELECT * FROM Accounts;");
    assert.equal(s.db.accounts[2].name,"O'Brien, A;--/*test*/"); assert.equal(s.db.accounts[2].cents,10);
});
test('malformed trailing SQL and unsupported filters are not silently ignored', () => {
    for (const sql of ['SELECT * FROM Accounts WHERE Acc_no = 1;', 'BEGIN TRANSACTION extra;', debit.replace(';',' OR 1=1;')]) {
        const s = fresh(); s.execute(sql); assert.equal(s.audit.at(-2)?.type === 'err' || s.audit.at(-1).type === 'err',true);
        assert.deepEqual(balances(s),[100000,50000]);
    }
});
test('syntax error inside transaction blocks subsequent commit', () => {
    const s = fresh(); s.execute('BEGIN TRANSACTION;' + debit + 'GARBAGE;'+credit+'COMMIT;');
    assert.equal(s.failed,true); assert.deepEqual(balances(s),[90000,50000]);
    s.execute('ROLLBACK;'); assert.equal(s.active,false);
});
test('unterminated string executes none of the submitted commands', () => {
    const s = fresh(); s.execute("BEGIN TRANSACTION; INSERT INTO Accounts VALUES (3, 'broken, 1);");
    assert.equal(s.active,false); assert.deepEqual(balances(s),[100000,50000]);
});
test('cents arithmetic stays exact after repeated decimal transfers', () => {
    const s = fresh(); const small = transfer.replaceAll('100 WHERE','0.10 WHERE');
    for (let i = 0; i < 100; i++) s.execute(small + 'COMMIT;');
    assert.deepEqual(balances(s),[99000,51000]); assert.equal(s.total(),150000);
});
test('overflow in receiving account is rejected and rollback restores both', () => {
    const s = new core.Engine(); s.execute(schema+"INSERT INTO Accounts VALUES (1, 'A', 10);INSERT INTO Accounts VALUES (2, 'B', 99999999.99);");
    s.execute(transfer.replaceAll('100 WHERE','1 WHERE')+'COMMIT;'); assert.equal(s.failed,true);
    s.execute('ROLLBACK;'); assert.deepEqual(balances(s),[1000,9999999999]);
});
test('empty rollback and commit before rollback do not complete assignment', () => {
    const s = fresh(); s.execute('BEGIN TRANSACTION;ROLLBACK;'); assert.equal(s.progress[3],false);
    s.execute(transfer+'COMMIT;'); assert.equal(s.progress[4],false);
});
test('step 5 requires the same transfer that was rolled back', () => {
    const s = fresh(); s.execute(transfer+'ROLLBACK;');
    s.execute(transfer.replaceAll('100 WHERE','50 WHERE')+'COMMIT;'); assert.equal(s.progress[4],false);
    s.execute(transfer+'COMMIT;'); assert.equal(s.progress[4],true);
});
test('nested BEGIN and COMMIT without active transaction produce errors', () => {
    const s = fresh(); s.execute('COMMIT;'); assert.equal(s.active,false);
    s.execute('BEGIN TRANSACTION;BEGIN TRANSACTION;'); assert.equal(s.failed,true); s.execute('ROLLBACK;'); assert.equal(s.failed,false);
});

// Minimal DOM doubles exercise the actual startup/render/persistence code, not a second implementation.
function startUI(store = {}, failStorage = false) {
    class Element {
        constructor() { this.children=[];this.textContent='';this.value=''; }
        appendChild(child) { this.children.push(child); }
        replaceChildren() { this.children=[]; }
        set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
    }
    const elements = {};
    const ctx = vm.createContext({ document:{getElementById:id=>elements[id] ||= new Element(),createElement:()=>new Element()},
        sessionStorage:{getItem:k=>{if(failStorage)throw Error('disabled');return store[k]||null;},setItem:(k,v)=>{if(failStorage)throw Error('disabled');store[k]=v;}},
        confirm:()=>true });
    vm.runInContext(script, ctx);
    return { elements, ctx, run(sql){elements['sql-input'].value=sql;vm.runInContext('executeSQL()',ctx);}, record(){return JSON.parse(vm.runInContext('JSON.stringify(exercise.record())',ctx));} };
}
test('startup editor is blank and renders text safely', () => {
    const ui = startUI(); assert.equal(ui.elements['sql-input'].value,'');
    ui.run(schema+"INSERT INTO Accounts VALUES (1, '<img src=x onerror=alert(1)>', 10);");
    assert.equal(ui.elements['accounts-body'].children[0].children[1].textContent,'<img src=x onerror=alert(1)>');
});
test('committed data and progress survive reload', () => {
    const store={};const ui=startUI(store);ui.run(init+transfer+'ROLLBACK;'+transfer+'COMMIT;');
    const restored=startUI(store).record(); assert.deepEqual(restored.db.accounts.map(a=>a.cents),[90000,60000]);
    assert.deepEqual(restored.progress,[true,true,true,true,true]);
});
test('reload discards uncommitted debit without crediting rollback milestone', () => {
    const store={};const ui=startUI(store);ui.run(init+'BEGIN TRANSACTION;'+debit);
    const restored=startUI(store).record();assert.deepEqual(restored.db.accounts.map(a=>a.cents),[100000,50000]);
    assert.equal(restored.progress[3],false);assert.equal(restored.interrupted,false);
});
test('storage unavailability and corrupt saved data do not crash UI', () => {
    const ui=startUI({},true);ui.run(init);assert.match(ui.elements['storage-note'].textContent,/غير متاح/);
    const broken=startUI({'practicalsql-assignment-v2':'invalid json'});assert.equal(broken.record().db.created,false);
});
test('reset clears saved data, progress and editor', () => {
    const store={};const ui=startUI(store);ui.run(init+transfer+'ROLLBACK;');vm.runInContext('resetEverything()',ui.ctx);
    assert.equal(ui.record().db.created,false);assert.deepEqual(ui.record().progress,[false,false,false,false,false]);
    assert.equal(startUI(store).record().db.accounts.length,0);assert.equal(ui.elements['sql-input'].value,'');
});
