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

const start = Date.now();
const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];

function rotateBackups() {
    try {
        const MAX_BACKUPS = config.MAX_BACKUPS;
        const BACKUP_DIR = config.BACKUP_DIR;


        const newBackup = path.join(BACKUP_DIR, `backup_${timestamp}`);
        fs.mkdirSync(newBackup, { recursive: true });

        let backups = fs.readdirSync(BACKUP_DIR)
            .filter(name => name.startsWith('backup_'))
            .map(name => ({
                name,
                time: fs.statSync(path.join(BACKUP_DIR, name)).ctime.getTime()
            }))
            .sort((a, b) => a.time - b.time);

        while (backups.length > MAX_BACKUPS) {
            const oldest = backups.shift();
            const oldestPath = path.join(BACKUP_DIR, oldest.name);
            fs.rmSync(oldestPath, { recursive: true, force: true });
        }

    } catch (err) {
        console.error("Fehler bei der Backup-Rotation:", err);
    }
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

        const exclusive = "TEST TH: NPE \\ F-Fügedetail"

        for (const project of projects.data) {
            if(!exclusive || project.attributes.name===exclusive) {

                const itemPath = path.join(config.BACKUP_DIR+"/backup_"+timestamp, project.attributes.name.replace(/[<>:"/\\|?*]+/g, "_"));
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
    const end = Date.now();
    const durationMs = end - start;
    const h = String(Math.floor(durationMs / 3600000)).padStart(2, '0');
    const m = String(Math.floor((durationMs % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((durationMs % 60000) / 1000)).padStart(2, '0');
    
    console.log(`\nLaufzeit: ${h}:${m}:${s}`);
    setTimeout(() => {
        process.exit(0);
    }, 5000);

}

async function downloadFile(urn, filename, folderPath, projectId, cursor = 0 ) {
    const token = await getAccessToken();
    const CHUNK_SIZE = 2000080000;
    let err = false;

    process.stdout.write("\x1b[1A");
    process.stdout.write("\x1b["+cursor+"C");

    const response = await fetch(`https://developer.api.autodesk.com/data/v1/projects/${projectId}/items/${urn}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    try {
        downloadurl = data.included[0].relationships.storage.meta.link.href.split("?");
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
                    process.stdout.write(` 🔴 \x1b[31mnicht gespeichert\x1b[0m\n`);
                    //throw new Error(`Fehler beim Herunterladen der Datei ${filename}: ${chunkResponse.statusText}`);
                    logErrorToFile(`Fehler beim Herunterladen der Datei ${filename}: ${chunkResponse.statusText}`);
                    err = true;
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
            process.stdout.write(` 🔴 \x1b[31mnicht gespeichert\x1b[0m\n`);
            logErrorToFile(error);
            console.error(`Fehler beim Schreiben der Datei ${filename}:`, error);
            err = true;

        } finally {
            fileStream.end();
            if(!err) { process.stdout.write(` 🟢 \x1b[32mgespeichert\x1b[0m\n`); }
        }
        
    } catch {
        logErrorToFile(data);
    }
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
            var MAX_BACKUPS = await askQuestion('Wieviele Backups behalten: ');
        
            config.CLIENT_ID = CLIENT_ID;
            config.CLIENT_SECRET = CLIENT_SECRET;
            config.BACKUP_DIR = BACKUP_DIR;
            config.MAX_BACKUPS = MAX_BACKUPS;
    
            saveFile('config.json',config);
        
            rl.close();
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