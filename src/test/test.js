const Registrar = require('../../src/index.js');
const ENS = require('ethereum-ens');

const assert = require('assert');
const fs = require('fs');
const solc = require('solc'); // eslint-disable-line
const TestRPC = require('ethereumjs-testrpc'); // eslint-disable-line
const Web3 = require('web3');

const web3 = new Web3();

let accounts = null;
let ens = null;
let ensRoot = null;
let registrar = null;

// web3.setProvider(TestRPC.provider()); // Unfortunately this doesn't support synchronous calls
web3.setProvider(new web3.providers.HttpProvider('http://localhost:8545'));


describe('Registrar', () => {
  before(function (done) { // eslint-disable-line
    this.timeout(20000);
    // Deploy the ENS registry and registrar
    web3.eth.getAccounts((err, accts) => {
      if (err) {
        throw err;
      }
      accounts = accts;
      /*
      // Use this block to recompile and save
      // Otherwise it's too slow for dev purposes
      const input = fs.readFileSync('test/dotEthRegistrar.sol').toString();
      const output = solc.compile(input, 1);
      const compiled = {};
      for (const contractName in output.contracts) {
        // code and ABI that are needed by web3
        compiled[contractName] = {};
        compiled[contractName].bytecode = output.contracts[contractName].bytecode;
        compiled[contractName].interface = JSON.parse(output.contracts[contractName].interface);
      }
      fs.writeFileSync('test/contracts.json', JSON.stringify(compiled));
      */
      // Use to speed up the testing process during development:
      const compiled = JSON.parse(fs.readFileSync('src/test/contracts.json').toString());
      const deployer = compiled['DeployENS']; // eslint-disable-line
      const deployensContract = web3.eth.contract(deployer.interface);

      deployensContract.new({
        from: accts[0],
        data: deployer.bytecode,
        gas: 4700000
      }, (deploymentErr, contract) => {
        assert.equal(deploymentErr, null);
        if (contract.address !== undefined) {
          contract.ens.call((contractErr, value) => {
            assert.equal(contractErr, null, contractErr);
            ensRoot = value;
            // The ethereum-ens module has a default address built in, but we can't
            // use that on testnet, so we get the ensRoot value from our deployment contract
            ens = new ENS(web3, ensRoot);
            contract.registrarInfo.call((registrarInfoErr, registrarInfoValue) => {
              assert.equal(registrarInfoErr, null, registrarInfoErr);
              assert.ok(registrarInfoValue !== null);
              registrar = new Registrar(web3, ens);
              done();
            });
          });
        }
      });
    });
  });

  describe('#openAuction()', () => {
    it('Should return an error when the name is too short', (done) => {
      registrar.openAuction('foo', { from: accounts[0] }, (err, txid) => {
        assert.equal(err, Registrar.TooShort);
        assert.equal(txid, null);
        done();
      });
    });

    it('Should return an error when the name contains special characters', (done) => {
      registrar.openAuction('fooøøôôóOOOo', { from: accounts[0] }, (err, txid) => {
        assert.equal(err, Registrar.SpecialCharacters);
        assert.equal(txid, null);
        done();
      });
    });


    it('Should set an `Open` node to status `Auction`', (done) => {
      registrar.openAuction('foobarbaz', { from: accounts[0], gas: 4700000 }, (err, txid) => {
        assert.equal(err, null);
        assert.equal(typeof txid, 'string');

        // TODO: also test to ensure that randomly generated decoy names are open
        const hash = registrar.sha3('foobarbaz');
        registrar.contract.entries.call(hash, (entryErr, entryResult) => {
          assert.equal(entryErr, null);
          const status = entryResult[0].toString();
          assert.equal(status, 1);
          done();
        });
      });
    });

    it('Should return an error if given a nameprepped-name with any status other than `Open`', (done) => {
      registrar.openAuction('foobarbaz', { from: accounts[0], gas: 4700000 }, (err, result) => {
        assert.ok(err.toString().indexOf('invalid JUMP') !== -1, err);
        assert.equal(result, null);
        done();
      });
    });
  });

  describe('#getEntry()', () => {
    it('Should return the correct properties of a name', (done) => {
      // a name being auctioned
      assert.equal(registrar.getEntry('foobarbaz').status, 1);
      // a name NOT being auctioned
      assert.equal(registrar.getEntry('thisnameisopen').status, 0);
      // test async too
      registrar.getEntry('foobarbaz', (err, result) => {
        assert.equal(result.name, 'foobarbaz');
        assert.equal(result.status, 1);
        assert.equal(result.deed.address, '0x0000000000000000000000000000000000000000');
        assert.ok(result.registrationDate - new Date(), result.registrationDate);
        assert.equal(result.value, 0);
        assert.equal(result.highestBid, 0);
      });
      registrar.getEntry('thisnameisopen', (err, result) => {
        assert.equal(result.name, 'thisnameisopen');
        assert.equal(result.status, 0);
        assert.equal(result.deed.address, '0x0000000000000000000000000000000000000000');
        assert.equal(result.registrationDate, 0);
        assert.equal(result.value, 0);
        assert.equal(result.highestBid, 0);
        done();
      });
    });
    it('Nameprep should ensure the same entry is returned regardless of capitalization', () => {
      assert.equal(registrar.getEntry('foobarbaz').hash, registrar.getEntry('FOOBarbaz').hash);
    });
  });

  describe('#submitBid()', () => {
    // generate and submit the bid
    let bidObject = null;
    before((done) => {
      const bid = registrar.bidFactory(
        'foobarbaz',
        '0x5834eb6b2acac5b0bfff8413622704d890f80e9e',
        web3.toWei(1, 'ether'), // value
        'secret',
        web3.toWei(2, 'ether') // deposit
      );
      bidObject = bid;
      done();
    });

    it('The bid should be a valid 32 byte hashed bid', () => {
      // The shaBid value was generated previously using web3 via the node repl
      const shaBid = '0xe686eacb824a48d85d81232df929536d630a0d0d225f8ce7ce68ba9f824a2606';
      assert.equal(bidObject.shaBid, shaBid);
    });

    it('Should create a new sealedBid Deed holding the value of deposit', (done) => {
      registrar.submitBid(bidObject,
        { from: accounts[0], value: web3.toWei(2, 'ether'), gas: 4700000 },
        (submitBidErr, submitBidResult) => {
          assert.equal(submitBidErr, null);
          assert.ok(submitBidResult != null);
          registrar.contract.sealedBids.call(
            bidObject.shaBid, (sealedBidError, sealedBidResult) => {
              assert.equal(sealedBidError, null);
              assert.ok(sealedBidResult !== '0x0000000000000000000000000000000000000000',
                sealedBidResult);
              assert.equal(web3.eth.getBalance(sealedBidResult), web3.toWei(2, 'ether'));
              done();
            });
        });
    });

    it('Should throw an error if a deposit amount is not equal or greater than the value', (done) => {
      done();
    });

    it('Should return the same hash for an identical Nameprep names', (done) => {
      done();
    });
  });

  describe.skip('#unsealBid()', () => {
    // The sealed bid created to test #newBid()
    const bid = '0xe686eacb824a48d85d81232df929536d630a0d0d225f8ce7ce68ba9f824a2606';
    const testOwner = '0x5834eb6b2acac5b0bfff8413622704d890f80e9e';
    const secret = 'secret';
    const value = web3.toWei(1, 'ether');
    it('Should delete the sealedBid Deed', (done) => {
      registrar.unsealBid('foobarbaz', testOwner, value, secret, { from: accounts[1], gas: 4700000 }, (err, result) => {
        assert.equal(err, null);
        assert.ok(result !== null);
        registrar.contract.sealedBids.call(bid, (sealedBidErr, sealedBidResult) => {
          assert.equal(sealedBidErr, null);
          assert.equal(sealedBidResult, '0x0000000000000000000000000000000000000000');
          done();
        });
      });
    });
    it('Should create a new Entry if it is the current highest bid', (done) => {
      registrar.getEntry('foobarbaz', (err, result) => {
        assert.equal(result.name, 'foobarbaz');
        assert.ok(result.deed.address !== '0x0000000000000000000000000000000000000000');
        assert.equal(Number(result.highestBid), web3.toWei(1, 'ether'));
        done();
      });
    });
  });

  describe.skip('#finalizeAuction()', () => {
    it('Should update the deed to hold the value of the winning bid', (done) => {
      // test body
      done();
    });
  });

  describe.skip('#invalidateName()', () => {
  });

  describe.skip('#invalidateName()', () => {
  });

  describe.skip('#releaseDeed()', () => {
  });

  describe.skip('#cancelBid()', () => {
  });
  describe.skip('#transfer()', () => {
  });
});


/* Snippet for creating new unit tests
  describe('...', () => {
    it('...', (done) =>  {
      // test body
      done();
    });
  });
*/