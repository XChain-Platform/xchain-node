/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Node - Utility 
 * 
 * This file provides utility functions used throughout the XChain node
 *
 ********************************************************************/

module.exports = {

    // Handle sleeping for a given number of milliseconds
    sleep: function(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Throw an error and log to console
    throwError: function(error){
        console.log(error);
        throw new Error(error);
    },

    // Start a debug timer
    startTimer: function(){
        let now = Date.now();
        return now;
    },

    // Log a timer using a given name
    logTimer: function(timer, timeName){
        let now = Date.now();
        let ms  = now - timer;
        var timeString = this.millisecondsToTimeString(ms);
        var niceString = (timeName!=null) ? timeName : 'Time';
        niceString += "\t: " + ms + 'ms';
        if(timeString!='')
            niceString += ' (' + timeString + ')';
        console.log(niceString);
    },

    // Create nice human readable time string based on miliiseconds
    millisecondsToTimeString: function(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        // Display time in XX format
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        // Build out time string to nicely display time
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    },

    downloadUrlFileRedirect: async function (path, url, maxRedirections=3) {
        return new Promise((resolve, reject) => {
            let redirectionsCount = 0
            while (newUrl != null) {
                try {
                    await downloadUrlFile(path, url)
                    newUrl = null
                    resolve(true)
                } catch (err) {
                    if (err != null) {
                        newUrl = err
                        redirectionsCount = redirectionsCount + 1
                    } else {
                        newUrl = null
                        reject(null)
                    }
                }
            }
        })
    },

    downloadUrlFile: async function (path, url) {
        return new Promise((resolve, reject) => {
            const downloadedFile = fs.createWriteStream(path)

            const request = https.get(url, function (response) {
                if (response.status == 302) {
                    reject(response.headers.location)
                } else {
                    response.pipe(downloadFile)

                    downloadFile.on("error", async () => {
                        console.log("An error happened while trying to download the bitcoin node")
                        reject(null)
                    })

                    //After download completed close filestream
                    downloadFile.on("finish", async () => {
                        downloadFile.close()
                        resolve(true)
                    })
                }
            })
        })
    }

}