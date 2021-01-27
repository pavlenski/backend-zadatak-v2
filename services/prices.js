const timestamp = require('unix-timestamp');
const globals = require('../utils/globals');
const Server = require('../models/servers');
const Price = require('../models/prices');
const axios = require('axios');
const Web3 = require('web3');
const Tx = require('ethereumjs-tx').Transaction;

const web3 = new Web3(globals.providerURL);
const contract = new web3.eth.Contract(globals.contractABI, globals.contractID)
timestamp.round = true;

async function sendTransaction(averagePrice, estimatedGas) {
    
    const tempPrivateKey = Buffer.from(globals.privateKeyHash, 'hex'); 
    const txCount = await web3.eth.getTransactionCount(globals.walletAddress);
    const data = contract.methods.setEthPrice(averagePrice).encodeABI();
    const txObject = {
        nonce: web3.utils.toHex(txCount),
        gasLimit: web3.utils.toHex(estimatedGas),
        gasPrice: web3.utils.toHex(web3.utils.toWei(globals.gasPrice.toString(), 'gwei')),
        to: globals.contractID,
        data: data,
    }
    
    const tx = new Tx(txObject, {'chain': 'kovan'});
    tx.sign(tempPrivateKey);

    const serializedTx = tx.serialize();
    const raw = '0x' + serializedTx.toString('hex');

    const txResult = await web3.eth.sendSignedTransaction(raw);
    return txResult;
} 

async function isItMyTurn() {

    const serverDoc = await Server.findOne({ index: 0 });
    return serverDoc.list[serverDoc.next] === globals.serverName
}

async function changeTurn() {

    const serverDoc = await Server.findOne({ index: 0 });
    next = serverDoc.next + 1 >= serverDoc.total ? 0 : serverDoc.next + 1;

    await Server.updateOne(
        { index: 0 },
        { $set: { next, } }
    );
    console.log(`[${globals.serverName} @ ${currentTimePretty()}]: changed turn.`);
}

function currentTimePretty() {
    let now = (timestamp.toDate(timestamp.now()));
    return now.toLocaleTimeString();
}

module.exports = {
    
    fetchCurrentPrices: async () => {

        const contractPrice = await contract.methods.getPrice().call()
        const { data } = await axios.get(globals.ethereumPriceURL);
        const returnData = {
            status: 200,
            msg: {
                description: `[${globals.serverName}]: current prices`, 
                api_price: data.ethereum.usd,
                contract_price: parseFloat(contractPrice)
            }
        };
        return returnData;
    },

    fetchAndAddNewPrice: async () => {

        const { data } = await axios.get(globals.ethereumPriceURL);
        const currentTime = timestamp.now();
        let newPrice = Price({
            price: data.ethereum.usd,
            timestamp: currentTime
        });
        const result = await newPrice.save();

        return { status: 200, msg: `[${globals.serverName} @ ${currentTimePretty()}]: price with id: '${result.id}' successfully created` };
    },

    updateContract: async () => {
        
        /* 
         * Check if its the servers turn to writeContract 
         */
        const turn = await isItMyTurn();
        if(turn == false) {
            return { status: 200, msg: `[${globals.serverName} @ ${currentTimePretty()}]: not my turn yet.` }
        }

        /* 
         * Check if 15 minutes passed since the last writeContract call 
         */
        const lastTimestamp = await contract.methods.getLastSetTimestamp().call();
        const currentTimestamp = timestamp.now();
        if(currentTimestamp - lastTimestamp < globals.fifteenMinutes) {
            return { status: 200, msg: `[${globals.serverName} @ ${currentTimePretty()}]: recently updated.. next call will be possible in ${globals.fifteenMinutes - (currentTimestamp - lastTimestamp)} seconds` }
        }

        // balance check

        const balance = await web3.eth.getBalance(globals.walletAddress);
        const balanceInEther = web3.utils.fromWei(balance, 'ether');
        if(balanceInEther < 0.001) {
            await changeTurn();
            axios.post('http://localhost:5000/fund-me', { walletAddress: globals.walletAddress })
            return { status: 200, msg: `[${globals.serverName} @ ${currentTimePretty()}]: not enough funds, changing order..` }
        }

        /* 
         * Check if there is enough data on the db to calculate the average price 
         */
        const averagePriceObj = await Price.aggregate([
            { $match: { timestamp: { $gt: currentTimestamp - globals.fifteenMinutes } } },
            { $group: { _id: null, avgPrice: { $avg: '$price' } } }
        ]);
        if(averagePriceObj === undefined || averagePriceObj.length == 0) {
            return { status: 404, msg: `[${globals.serverName} @ ${currentTimePretty()}]: insufficient data on db, could not calculate avg price`}
        }
        
        /* 
         * Check if the price jumped or lowered by 2% from the current contract price
         */
        const contractPrice = await contract.methods.getPrice().call();
        const averagePrice = Math.floor(averagePriceObj[0].avgPrice);
        if(averagePrice < (contractPrice * 1.02) && averagePrice > (contractPrice * 0.98)) {
            await changeTurn();
            return { status: 200, msg: `[${globals.serverName} @ ${currentTimePretty()}]: average price has not changed more than 2% of the current contract price` }
        }

        /* 
         * Send transaction
         */
        const gasEstimate = await contract.methods.setEthPrice(averagePrice).estimateGas({from: globals.walletAddress});
        const txResponse = await sendTransaction(averagePrice, gasEstimate);
        await changeTurn();

        return { status: 200, msg: `[${globals.serverName} @ ${currentTimePretty()}]: successfully created transaction: ${txResponse.transactionHash}` }

    },

    deleteOldPrices: async () => {

        let currentTime = timestamp.now()
        const result = await Price.deleteMany( { timestamp: { $lt: currentTime - globals.fifteenMinutes } } );
        
        let msg = `[${globals.serverName} @ ${currentTimePretty()}]: successfully deleted ${result.deletedCount} old price(s)`;
        if(result.deletedCount < 1) {
            msg = `[${globals.serverName} @ ${currentTimePretty()}]: all prices are still fresh, none deleted.`
        }
        return { status: 200, msg }
    }

}