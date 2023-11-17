/**
 * @fileoverview Demo application of loading synthetic contact center call recording meta-data and transcripts/vectors
 * into Redis.  Example search scenarios are then executed.
 */

import { faker } from '@faker-js/faker';
import { createClient, SchemaFieldTypes, VectorAlgorithms } from 'redis';
import fs from 'node:fs';
import { OpenAI } from 'openai';
import * as dotenv from 'dotenv';
import * as path from 'path';

const META_DATA = `${process.cwd()}/data/meta.json`;
const TRANSCRIPTS = `${process.cwd()}/data/transcripts.json`;
const AUDIO_DIR = `${process.cwd()}/data/audioFiles`;
const NUM_RECORDS = 20;
const NUM_SKILLS = 5;
const NUM_TEAMS = 5;

/**
 * Utility creating and loading Redis with synthetic contact center recording meta data.
 * @param {RedisClientType} redis - Redis client
 * @param {OpenAI} openai - OpenAI client
 * @returns - null
 */
async function loadData(redis, openai) {
    console.log('\n*** loadData ***')
    try {
        fs.statSync(META_DATA)  //check for meta data file existence
    }
    catch (err) {  //file doesn't exist, create it
        console.log('Meta data not found, Creating')
        await createMetaData(openai);
    }

    console.log('Inserting JSON documents into Redis');
    const docs = JSON.parse(fs.readFileSync(META_DATA));
    for (let doc of docs) {
        await redis.json.set(`contactId:${doc.contactId}`, '.', doc)
    }       
}

/**
 * Builds a Redis Search index on various fields in the call recording JSON objects.
 * @param {RedisClientType} redis - Redis client
 * @returns - null
 */
async function buildIndex(redis) {
    console.log('\n*** buildIndex ***');
    console.log('Creating Redis Search Index');
    try { await redis.ft.dropIndex('contactIdx') }
    catch (err) {};

    await redis.ft.create('contactIdx', {
            '$.contactStartDate': {
                type: SchemaFieldTypes.TEXT,
                AS: 'contactStartDate'
            },
            '$.mediaType': {
                type: SchemaFieldTypes.TAG,
                AS: 'mediaType'
            },
            '$.agentId': {
                type: SchemaFieldTypes.NUMERIC,
                AS: 'agentId'
            },
            '$.text': {
                type: SchemaFieldTypes.TEXT,
                AS: 'text'
            },
            '$.vector': {
                type: SchemaFieldTypes.VECTOR,
                AS: 'vector',
                ALGORITHM: VectorAlgorithms.FLAT,
                TYPE: 'FLOAT32',
                DIM: 1536,
                DISTANCE_METRIC: 'COSINE'
            }
        }, 
        { ON: 'JSON', PREFIX: 'contactId:'}
    );
}

/**
 * Creates an array of JSON objects each of which contain meta-data, transcript, and vector of a particular
 * call recording.  Those objects are then written to file.  The Faker lib is heavily leveraged.
 * @param {OpenAI} openai - OpenAI client
 * @returns - null
 */
async function createMetaData(openai) {
    console.log('\n*** createMetaData ***');
    try {
        fs.statSync(TRANSCRIPTS)  //check if transcripts/vectors file has already been created
    }
    catch (err) {
        console.log('Transcript data not found.  Creating transcript file.');
        await createTranscripts(openai);
    }
    const transcripts = JSON.parse(fs.readFileSync(TRANSCRIPTS));

    let docs = [];
    let skills = {};
    for (let i=0; i<NUM_SKILLS; i++) {
        skills[`${faker.word.noun()}_skill`] = faker.number.int({min:18599999, max:20699999});
    }
    let teams = {};
    for (let i=0; i<NUM_TEAMS; i++) {
        teams[`${faker.word.noun()}_team`] = faker.number.int({min:8207999, max:8208999});
    }
    const mediaTypes = ['Phone'];
    const intervalFormatter = new Intl.DateTimeFormat('en-US', {dateStyle: 'short', hour12:false, timeStyle: 'short'}) 
    const contactFormatter = new Intl.DateTimeFormat('en-US', {dateStyle: 'short', hour12:true, timeStyle: 'short'}) 
    
    console.log(`Creating ${NUM_RECORDS} synthetic contact center recording meta data records.`)
    for (let i=0; i < NUM_RECORDS; i++) {
        const transcript = faker.helpers.arrayElement(transcripts);
        const interval = intervalFormatter.format(faker.date.recent()).replace(/,/, "");
        let start = new Date(interval);
        const contactId = parseInt(faker.string.numeric({length:12}));
        const [teamName, teamId] = faker.helpers.objectEntry(teams);
        const [skillName, skillId] = faker.helpers.objectEntry(skills);

        docs.push({
            interval: interval,
            sourceId: faker.number.int({min:1, max: 5}),
            contactId: contactId,
            masterContactId: contactId,
            contactStartDate: contactFormatter.format(
                faker.date.between({from: interval, to: start.setHours(start.getHours() + 1)})
            ).replace(/,/, ""),
            mediaType: faker.helpers.arrayElement(mediaTypes),
            agentId: parseInt(faker.string.numeric({length: 8})),
            firstName: faker.person.firstName(),
            lastName: faker.person.lastName(),
            teamId: teamId,
            teamName: teamName,
            skillId: skillId,
            skillName: skillName,
            isOutbound: faker.number.int({min:0, max:1}),
            fromAddr: faker.helpers.replaceSymbolWithNumber('##########'),
            toAddr: faker.helpers.replaceSymbolWithNumber('##########'),
            file: transcript.file,
            text: transcript.text,
            vector: transcript.vector
        });
    }

    const json = JSON.stringify(docs);
    fs.writeFileSync(META_DATA, json);
    return;
}

/**
 * Creates an array of JSON objects each of which contain the transcript and embedding of a call recording.  
 * @param {OpenAI} openai - OpenAI client
 * @returns - null
 */
async function createTranscripts(openai) {
    console.log('Creating transcripts');
    const files = fs.readdirSync(AUDIO_DIR);
    const transcripts = [];
    for (let file of files) {
        const text = await getTranscript(openai, path.join(AUDIO_DIR, file));
        const vector = await getVector(openai, path.join(AUDIO_DIR, file), text);
        transcripts.push({
            file: file,
            text: text,
            vector: vector
        });
    }
    const json = JSON.stringify(transcripts);
    fs.writeFileSync(TRANSCRIPTS, json);
}

/**
 * Creates a transcript of call recording via Openai Whisper-1 model.  That output is then run back thru GPT-3 for
 * spell checking.  
 * @param {OpenAI} openai - OpenAI client
 * @param {string} file - name of recording file
 * @returns {string} call transcript
 */
async function getTranscript(openai, file) {
    console.log(`Transcribing: ${path.basename(file)}`);
    const transcript = await openai.audio.transcriptions.create({
        file: fs.createReadStream(file),
        model: 'whisper-1',
        response_format: 'text'
    });

    const prompt = 'Your task is to correct any spelling errors in the transcribed text. Only add necessary punctuation.'
    const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [ { role: 'system', content: prompt }, { role: 'user', content: transcript } ],
        temperature: 0
    });
    return completion.choices[0].message.content;
}

/**
 * Creates an embedding of a transcribed call recording via Openai Ada-002 model.  T
 * @param {OpenAI} openai - OpenAI client
 * @param {string} file - file name
 * @param {string} text - call transcript
 * @returns {number[]} embedding
 */
async function getVector(openai, file, text) {
    if (file) {
        console.log(`Embedding: ${path.basename(file)}`);
    }
    const response = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: text
    });
    return response.data[0].embedding;
}

/**
 * Redis Search Scenario
 * @param {RedisClientType} redis - Redis client
 * @returns - null
 */
async function scenario1(redis) {
    console.log('\n*** Search Scenario 1 - Meta Data Search ***');
    console.log('Find all the call recordings from agentID 17210096\n');

    const date = '11/12/23*'
    const mediaType = 'Phone'
    const t1 = process.hrtime();
    const res = await redis.ft.search('contactIdx', `'@agentId:[17210096 17210096] @mediaType:{${mediaType}}'`,
        {
            RETURN: '$.file'
        }
    );
    const t2 = process.hrtime();
    console.log(`Redis exec time: ${execTime(t1, t2)} ms`);
    if (res && res.documents) {
        for (const doc of res.documents) {
            console.log(doc.value['$.file']);
        }    
    }
}

/**
 * Redis Search Scenario
 * @param {RedisClientType} redis - Redis client
 * @returns - null
 */
async function scenario2(redis) {
    console.log('\n*** Search Scenario 2 - Transcript Lexical Search ***');
    console.log('Find all the call recordings whose transcripts had the term "Philadelphia" in them\n');

    const term = 'Philadelphia';
    const mediaType = 'Phone';
    const t1 = process.hrtime();
    const res = await redis.ft.search('contactIdx', `'@text:${term} @mediaType:{${mediaType}}'`,
        {
            RETURN: '$.file'
        }
    );
    const t2 = process.hrtime();
    console.log(`Redis exec time: ${execTime(t1, t2)} ms`);
    if (res && res.documents) {
        for (const doc of res.documents) {
            console.log(doc.value['$.file']);
        }     
    }
}

/**
 * Redis Search Scenario
 * @param {RedisClientType} redis - Redis client
 * @returns - null
 */
async function scenario3(redis, openai) {
    console.log('\n*** Search Scenario 3 - Transcript Semantic Search ***');
    console.log("Find the most relevant recording with a discussion of health insurance\n");

    const query = "I'm looking for health insurance related transcripts";
    const queryVector = await getVector(openai, null, query);
    const mediaType = 'Phone';
    const t1 = process.hrtime();
    const res = await redis.ft.search('contactIdx', '*=>[KNN 1 @vector $query_vec]', {
        PARAMS: { query_vec: Buffer.from(new Float32Array(queryVector).buffer) },
        DIALECT: 2
    });
    const t2 = process.hrtime();
    console.log(`Redis exec time: ${execTime(t1, t2)} ms`);
    if (res && res.documents) {
        for (const doc of res.documents) {
            console.log(doc.value.text);
        }     
    }
}

function execTime(start, finish) {
    const finishMS = finish[0] * 1000 + finish[1] / 1000000;
    const startMS = start[0] * 1000 + start[1] / 1000000;
    return parseFloat((finishMS - startMS).toFixed(2));
}

(async () => {
    dotenv.config();
    const user = process.env.RE_USER;
    const pwd = process.env.RE_PWD;
    const host = process.env.RE_HOST;
    const port = process.env.RE_PORT;
    const redis = createClient({url: `redis://${user}:${pwd}@${host}:${port}`});
    const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

    await redis.connect();
    await redis.flushDb();
    await buildIndex(redis);
    await loadData(redis, openai);
    await scenario1(redis);
    await scenario2(redis);
    await scenario3(redis, openai)
    await redis.disconnect();
})();