const fs = require('fs');
const path = require('path');
const readline = require('readline');

const configDir = './';

if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
}
  
const configExists = (file) => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify({}, null, 2));
    }
};

const saveFile = (file, data) => fs.writeFileSync(`${configDir}/${file}`, JSON.stringify(data, null, 2));

const loadFile = (file) => {
  configExists(`${configDir}/${file}`);
  return JSON.parse(fs.readFileSync(`${configDir}/${file}`, 'utf8'));
};

const config = loadFile('config.json');

const logFile = path.join(process.cwd(), 'error.log');

function logErrorToFile(error) {
    const errorMessage = `[${new Date().toISOString()}] ${error.stack || error}\n`;
    fs.appendFileSync(logFile, errorMessage);
}

function rotateBackups() {
    for (let i = 4; i > 1; i--) {
        const oldPath = path.join(config.BACKUP_DIR, `backup_${i - 1}`);
        const newPath = path.join(config.BACKUP_DIR, `backup_${i}`);
        if (fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, newPath);
        }
    }

    const oldestBackup = path.join(config.BACKUP_DIR, 'backup_4');
    if (fs.existsSync(oldestBackup)) {
        fs.rmSync(oldestBackup, { recursive: true, force: true });
    }

    const newBackup = path.join(config.BACKUP_DIR, 'backup_1');
    fs.mkdirSync(newBackup, { recursive: true });
}

async function getAccessToken() {
    try {
        const response = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`${config.CLIENT_ID}:${config.CLIENT_SECRET}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                scope: 'data:read',
            }),
        });

        if (!response.ok) {
            throw new Error(`Fehler beim Abrufen des Tokens: ${response.statusText}`);
        }

        const data = await response.json();
        return data.access_token;
    } catch (error) {
        console.error(error);
    }
}

async function listHubs() {
    const token = await getAccessToken();
    const response = await fetch('https://developer.api.autodesk.com/project/v1/hubs', {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    return data.data;
}

async function listProjects() {
    const hubs = await listHubs();
    for (const hub of hubs) {
        console.log(`Hub: ${hub.attributes.name} / ${hub.id}`);
        const token = await getAccessToken();
        const response = await fetch(`https://developer.api.autodesk.com/project/v1/hubs/${hub.id}/projects`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const projects = await response.json();

        const exclusive = ""

        for (const project of projects.data) {
            if(!exclusive || project.attributes.name===exclusive) {

                const itemPath = path.join(config.BACKUP_DIR+"/backup_1", project.attributes.name.replace(/[<>:"/\\|?*]+/g, "_"));
                fs.mkdirSync(itemPath, { recursive: true });

                console.log(`\nProjekt: ${project.attributes.name} (${project.id})`);
                const response = await fetch(`https://developer.api.autodesk.com/project/v1/hubs/${hub.id}/projects/${project.id}/topFolders`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const data = await response.json();
               
                for (const folder of data.data) {
                        if(folder.attributes.displayName ==="Project Files") {
                            console.log('|- '+folder.attributes.displayName);
                            const contents = await listFiles(folder.id, project.id, 1, itemPath);
                        }              
                }
            }
        }
    }
}


async function downloadFile(urn, filename, folderPath, projectId, cursor = 0 ) {
    const token = await getAccessToken();

    const CHUNK_SIZE = 2000080000;

    const response = await fetch(`https://developer.api.autodesk.com/data/v1/projects/${projectId}/items/${urn}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    downloadurl = data.included[0].relationships.storage.meta.link.href.split("?")

    const fileresponse = await fetch(downloadurl[0]+"/signeds3download", {
        headers: { Authorization: `Bearer ${token}` }
    });
    const fileData = await fileresponse.json();

    const fileUrl = fileData.url;

    const filePath = path.join(folderPath);
    let start = 0;
    let partCounter = 1;

    const fileStream = fs.createWriteStream(filePath);

    try {
        while (true) {
            const end = start + CHUNK_SIZE - 1;
            const chunkResponse = await fetch(fileUrl, {
                headers: { Range: `bytes=${start}-${end}` }
            });

            if (!chunkResponse.ok && chunkResponse.status !== 206 && chunkResponse.status !== 200) {
                throw new Error(`Fehler beim Herunterladen der Datei: ${chunkResponse.statusText}`);
            }

            const chunkBuffer = await chunkResponse.arrayBuffer();
            fileStream.write(Buffer.from(chunkBuffer));

            start += CHUNK_SIZE;
            partCounter++;

            if (chunkBuffer.byteLength < CHUNK_SIZE) {
                break;
            }
        }
    } catch (error) {
        logErrorToFile(error);
        console.error(`Fehler beim Schreiben der Datei ${filename}:`, error);
    } finally {
        fileStream.end();
    }
    process.stdout.write("\x1b[1A");
    process.stdout.write("\x1b["+cursor+"C");
    process.stdout.write(` ✅ \x1b[32mGespeichert\x1b[0m\n`);
}

async function listFiles(folderId, projectId, depth = 2, localPath) {
    const token = await getAccessToken();
    const response = await fetch(`https://developer.api.autodesk.com/data/v1/projects/${projectId}/folders/${folderId}/contents`, {
        headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();

    for (const content of data.data) {

        const indent = "|" + "  ".repeat(depth) + "└─ ";
        const name = content.attributes.displayName;
        const itemPath = path.join(localPath, name.replace(/[<>:"/\\|?*]+/g, "_"));
        const str = indent +" "+ name;

        console.log(str);
        if(content.type === 'folders') {
            fs.mkdirSync(itemPath, { recursive: true });
            await listFiles(content.id, projectId, depth + 2, itemPath);
        } else if (content.type === 'items') {
            await downloadFile(content.id, name, itemPath, projectId, str.length)
        }
    }    
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  

const askQuestion = (question) => {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
        resolve(answer);
        });
    });
};

const init = async () => {
    if(config.hasOwnProperty('CLIENT_ID')) {
        return config;
    } else {
        try {
            console.log('Bitte Client Id & Client Secret eigeben');
            var CLIENT_ID = await askQuestion('Client Id: ');
            var CLIENT_SECRET = await askQuestion('Client Secret: ');
            var BACKUP_DIR = await askQuestion('Backup Verzeichnis: ');
        
            config.CLIENT_ID = CLIENT_ID;
            config.CLIENT_SECRET = CLIENT_SECRET;
            config.BACKUP_DIR = BACKUP_DIR;
    
            saveFile('config.json',config);
        
            rl.close(); // Beendet das Readline-Interface
            return config;
        
            } catch (error) {
            console.error(`Ein Fehler ist aufgetreten`, error);
        }
    }
};

async function backupProjects() {
    rotateBackups();
    listProjects();
}

init().then(() => {
    backupProjects()
    .catch(error => {
        console.error('Fehler:', error.message);
    });
});



