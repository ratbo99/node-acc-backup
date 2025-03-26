# Node Autodesk Construction Cloud Backup
A small Node Script to Backup your Autodesk Construction Cloud Projects

## Getting Started
* Create a Server-to-Server Application in the Autodesk Developer Portal: https://aps.autodesk.com/
* select these two APIs: Autodesk Construction Cloud API, Data Management API
* More Information: https://aps.autodesk.com/en/docs/oauth/v2/tutorials/create-app/

## Installing
* Download and installing Node.js, or just download the .exe file from Releases

## Executing program
* start server.js, or the .exe file
* type in the CLIENT_ID and CLIENT_SECRET from the previous created App
* type in your Backup Destination.

## Important
for security reasons the generated downloadlinks are only valid for 2 minutes by default, which may is to low for large files.
to make sure the links are only valid for a short amount of time, the script assume a 100mbit bandwith internet to calculate the expirationtime for the links.
if you ran in any problems with a slower connection set SPEEDTEST to true in config.json to perform a speedtest at startup, to determinate the actual bandwith.

## TODO
* get symlinks, hardlinks, or junctions working correctly

## Acknowledgments
* [Autodesk Construction Cloud Backup](https://github.com/stewartcelani/autodesk-construction-cloud-backup)
