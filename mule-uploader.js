/**
 * mule-upload.js v.1.0.1
 * https://github.com/FlixMaster/mule-uploader
 * https://github.com/cinely/mule-uploader
 *
 * Copyright 2012-2013, Gabriel Purcaru
 * Released under GPL License.
 * License: http://www.gnu.org/copyleft/gpl.html
 */
(function () {
    // custom logging function that prepends a text for easy identification;
    // it is also toggled by the `debug` flag
    var logger = function() {
        var args = ["[MuleUploader]"];
        for(var i=0; i<arguments.length; i++) {
            args.push(arguments[i]);
        }
        return console.log.apply(console, args);
    };

    // AJAX helper. It takes an object that contains load_callback, error_callback,
    // url, method, headers, state_change_callback, progress_callback
    var XHR = function(args) {
        // the user may not pass any headers
        args.headers = args.headers || {};

        // if no method is given, default to GET
        args.method = args.method || "GET";

        var xhr = new XMLHttpRequest();
        // set the "load" callback if given
        if(args.load_callback && typeof args.load_callback == 'function') {
            xhr.addEventListener("load", args.load_callback.bind(this), true);
        }

        // set the "error" callback if given
        if(args.error_callback && typeof args.error_callback == 'function') {
            xhr.addEventListener("error", args.error_callback.bind(this), true);
        }

        // set the "readystatechange" callback if given
        if(args.state_change_callback && typeof args.state_change_callback == 'function') {
            xhr.addEventListener("readystatechange", args.state_change_callback.bind(this));
        }

        // set the "progress" callback if given
        if(args.progress_callback && typeof args.progress_callback == 'function') {
            xhr.upload.addEventListener("progress", args.progress_callback.bind(this));
        }

        // set the "timeout" callback if given
        if(args.timeout_callback && typeof args.timeout_callback == 'function') {
            xhr.addEventListener('timeout', timeout_callback.bind(this));
        }

        // adding extra params as needed
        var url = args.url;
        if(args.extra_params) {
            for(var param_name in args.extra_params) {
                if(url.indexOf('?') !== -1) {
                    url += "&";
                } else {
                    url += "?";
                }

                url += encodeURIComponent(param_name) + "=";
                url += encodeURIComponent(args.extra_params[param_name]);
            }
        }

        // open the xhr connection
        xhr.open(args.method, url);

        // set the headers
        for(var header in args.headers) {
            xhr.setRequestHeader(header, args.headers[header]);
        }

        // send the ajax call
        if(args.body) {
            xhr.send(args.body);
        } else {
            xhr.send();
        }
        return xhr;
    };

    // helper constants for more readable code
    var KB = 1024;
    var MB = 1024 * KB;
    var GB = 1024 * MB;
    var DONE_STATE = 4;

    // for new webkit browsers, the .slice() method is named .webkitSlice()
    // similar for mozilla
    File.prototype.slice = File.prototype.webkitSlice || File.prototype.mozSlice || File.prototype.slice;

    window.mule_upload = function (settings) {
        // verify that the browser has the needed HTML5 capabilities
        if(!(window.File && window.FileList && window.Blob)) {
            return -1;
        }
        if(navigator.userAgent.indexOf("Firefox") !== -1) {
            try {
                new Blob(["something"]);
            } catch(e) {
                return -1;
            }
        }

        return new Uploader(settings);
    };

    window.mule_upload.version = "1.0.1";

    //********************//
    //** Uploader Class **//
    //********************//

    function Uploader(settings) {
        // `u` is often used as an alias for `this` to be used in nested closures
        var u = this;

        settings = settings || {};

        if(settings.debug && console && console.log) {
            u.log = logger;
        }
        else {
            u.log = function() {};
        }

        // make the input element another possible setting
        // in some cases (e.g. drag & drop) there is no input element
        u.input = settings.file_input;
        if (settings.file_input_selector) {
            u.input = document.getElementById(settings.file_input_selector);
        }
        u.file  = settings.file;

        // NOTE: For Amazon S3, the minimum chunk size is 5MB
        // we are using 6 for safe measure. Note that the maximum number of chunks
        // is 10,000, so for example, if the chunk size is 6MB, the maximum
        // possible file size is 6MB * 10,000 = ~58GB
        settings.chunk_size = settings.chunk_size || (6 * MB); // default 6MB
        settings.max_size = settings.max_size || 0; // default to 0

        // the number of parallel upload xhr's
        settings.num_workers = settings.num_workers || 4;

        // automatically upload on file select
        if (typeof settings.auto_upload !== "boolean") {
            settings.auto_upload = true;
        }

        // the S3 object key; I recommend to generate this dynamically (e.g.
        // a random string) to avoid unwanted overwrites.
        if (settings.base_key) {
            settings.temp_filename = Math.floor(Math.random() * Math.pow(10, 10)).toString();
            settings.key = settings.base_key + settings.temp_filename;
        } else {
            settings.key = settings.key || "the_key";
        }

        // the Amazon S3 bucket where you'll store the uploads
        settings.bucket = settings.bucket;
        settings.host = settings.host || "http://" + settings.bucket + ".s3.amazonaws.com";

        // the Amazon S3 access key. DO NOT give the AWS Secret code!
        settings.access_key = settings.access_key;

        // the Mime-Type of the content. You must match this with the backend value
        // or you'll get an Invalid Signature error. If unsure about the
        // mime type, use application/octet-stream
        // ... this now serves as a backup for the file.type content type
        settings.content_type = settings.content_type || "application/octet-stream";


        // acl can be set to:
        // private
        // public-read (* default)
        // public-read-write
        // authenticated-read
        // bucket-owner-read
        // bucket-owner-full-control
        // log-delivery-write
        settings.acl = settings.acl || 'public-read';

        // various callbacks
        settings.on_progress = settings.on_progress || function() {};
        settings.on_chunk_progress = settings.on_chunk_progress || function() {};
        settings.on_select = settings.on_select || function() {};
        settings.on_error = settings.on_error || function() {};
        settings.on_complete = settings.on_complete || function() {};
        settings.on_init = settings.on_init || function() {};
        settings.on_start = settings.on_start || function() {};
        settings.on_chunk_uploaded = settings.on_chunk_uploaded || function() {};

        // time to wait before retrying an XHR operation, default 1 second.
        settings.retry_timeout = settings.retry_timeout || 1000;
        // times to retry before failing permanently
        settings.retry_limit = settings.retry_limit || 5;
        u.retry_count = 0;

        // extra parameters to give to the backend
        settings.extra_params = settings.extra_params || {};

        // the location prefix of the uploader's backend
        settings.ajax_base = settings.ajax_base || "/upload-backend";

        //extensions comma delimited without period (jpg,jpeg,png,gif)
        settings.accepted_extensions = settings.accepted_extensions || "";

        // set the values so that they can be used everywhere, as needed
        u.settings = settings;

        // the "waiting" state means the uploader is waiting for the user
        // to select a file
        u.set_state("waiting");

        if (u.input) {
            u.input.onchange = function(e, force) {
                // the `onchange` event may be triggered multiple times, so we
                // must ensure that the callback is only executed the first time
                if(u.get_state() != "waiting") {
                    return false;
                }

                // the uploader doesn't support multiple uploads at this time,
                // so we get the first file
                var file = e.target.files[0];
                u.upload_file(file, force);
            };
        }

        // trigger the init event callback
        setTimeout(function() {
            u.settings.on_init.apply(u);
        }, 100);

        u.log("OK");
    }

    Uploader.prototype.upload_file = function(file, force) {
        var u = this;
        // the `onchange` event may be triggered multiple times, so we
        // must ensure that the callback is only executed the first time
        // also make sure the file is not already set.
        if(u.get_state() != "waiting") {
            return false;
        }

        if (file) {
            u.file = file;
        }

        if (!u.file) {
            return false;
        }

        // we use the lastModifiedDate, the file name and size to uniquely
        // identify a file. There may be false positives and negatives,
        // but the chance for a false positive is basically zero.
        // some browsers don't report the last modified date, so we default
        // to a blank date
        u.file.lastModifiedDate = u.file.lastModifiedDate || new Date(0);

        if(u.file.size > u.settings.max_size) {
            alert("The maximum allowed file size is " + (u.settings.max_size / GB) + "GB. Please select another file.");
            return;
        }

        // check for accepted extensions, if applicable
        if(u.settings.accepted_extensions) {
            // get the file extension
            var file_extension = u.file.name.split('.').pop().toLowerCase();

            // split the given extensions into an array
            extensions_array = u.settings.accepted_extensions.split(',');

            // and match the extension against the given extension list
            var file_accepted = false;
            for(var i=0; i<extensions_array.length; i++) {
                if(file_extension == extensions_array[i]) {
                    file_accepted = true;
                    break;
                }
            }

            // if the file is not accepted, notify the user and return
            if(!file_accepted) {
                alert("This file format is not accepted. Please use a file with an extension like '" + u.settings.accepted_extensions);
                return;
            }
        }

        // Allow cancelling
        var proceed = u.settings.on_select.call(u, u.file);
        if (typeof proceed === "boolean" && !proceed) {
            return;
        }

        // from now on, we are "processing" the file upload
        u.set_state("processing");

        if (u.settings.auto_upload) {
            u.start_upload(force);
        }
    };

    Uploader.prototype.start_upload = function(force) {
        var u = this;
        // initialize the file upload
        // we need the `init` signature for this
        u.get_init_signature(function(signature, date) {
            if(!u.upload_id) {
                // the backend doesn't report an older upload
                var authorization = "AWS " + u.settings.access_key + ":" + signature;
                var handler = function(e) {
                    // trigger the on_select event callback
                    var xml = e.target.responseXML;

                    // get the given upload id
                    u.upload_id = xml.getElementsByTagName('UploadId')[0].textContent;

                    // get all signatures, then initiate the file upload
                    u.get_all_signatures(function() {
                        u.load_file(u.file);
                    });
                };
                XHR.call(u, {
                    method: "POST",
                    url: u.settings.host + "/" + u.settings.key + "?uploads",
                    load_callback: handler,
                    error_callback: u.error_handler,
                    headers: {
                        "x-amz-date": date,
                        "x-amz-acl": u.settings.acl,
                        "Authorization": authorization,
                        "Content-Type": u.file.type || u.settings.content_type,
                        "Content-Disposition": "attachment; filename=" + u.file.name
                    }
                });
            } else {
                // resume a previous upload
                if(!force) {
                    // get the uploaded parts from S3
                    u.list_parts(function() {
                        // start the upload
                        u.get_all_signatures(function() {
                            u.load_file(u.file);
                        });
                    }, function() {
                        // if it fails, re-initiate the upload, and force
                        // it to start a new upload
                        u.upload_id = null;
                        u._progress = null;
                        u._total_progress = null;
                        u._loaded_chunks = null;
                        u._uploading_chunks = null;
                        u._chunks = null;
                        return u.upload_file(u.file, true); // force reload
                    });
                } else {
                    // force-start the upload
                    u.get_all_signatures(function() {
                        u.load_file(u.file);
                    });
                }
            }
        }, force);
    };

    // this initiates the file upload
    Uploader.prototype.load_file = function(file) {
        var u = this;

        // we can't start the upload if we are waiting for user input
        if(u.get_state() == "waiting") {
            return;
        }

        // make sure we only trigger the start event once
        if(!u._start_fired) {
            // trigger the start event callback
            u.settings.on_start.call(u, u.file);

            // and also trigger a progress callback with 0%
            u.settings.on_progress.call(u, 0, u.file.size);
            u._start_fired = true;
        }

        // at this point we may have some chunks already uploaded,
        // so we may trigger a progress callback with the reported progress
        u.settings.on_progress.call(u, u.get_total_progress(), u.file.size);

        // get the next chunk
        var next_chunk = u.get_next_chunk();

        if(next_chunk != -1) {
            // and start uploading it
            u.upload_chunk(next_chunk);
        } else if(u.upload_finished()) {
            // if we finished, trigger the upload finish sequence
            u.log("All done; finish upload");
            u.finish_upload();
        }

        for(var i=0; i < u.settings.num_workers - 1; i++) {
            next_chunk = u.get_next_chunk();
            if(next_chunk !== -1) {
                u.upload_chunk(next_chunk);
            } else {
                break;
            }
        }
    };

    // this uploads a single chunk to S3
    Uploader.prototype.upload_chunk = function(chunk) {
        var u = this;
        // make sure we're in processing mode
        if(u.get_state() != "processing") {
            u.log("NOT processing; return");
            return;
        }

        // also make sure we're not already uploading this chunk
        if(u.get_chunk_uploading(chunk)) {
            u.log("Already Uploading");
            setTimeout(function() {
                var next_chunk = u.get_next_chunk();
                if(next_chunk !== -1) {
                    u.get_all_signatures(function() {
                        u.upload_chunk(u.get_next_chunk());
                    });
                }
            }, 1000);
            return;
        } else {
            // mark this chunk as uploading
            u.set_chunk_uploading(chunk);
        }
        u.log("Uploading Chunk: " + chunk);

        // we need the chunk's upload signature to initiate the
        // chunk upload. Note that we may already have the chunk signature at
        // this point (e.g. given by get_all_signatures), but we can throw
        // get_X_signature's around because ajax calls are only initiated
        // if we don't already have the needed signatures.
        u.get_chunk_signature(chunk, function(signature, date) {
            var length = u.settings.chunk_size;

            // get the start and end bytes for the needed chunk
            var start = chunk * length;
            var end = Math.min(start + length, u.file.size);

            // we need the last progress time in order to detect hanging
            // uploads
            var last_progress_time = new Date();
            u._intervals = u._intervals || {};

            // if we already uploaded this chunk, get to the next one
            // if there is no next chunk, finish the upload
            if(u.is_chunk_loaded(chunk)) {
                var next_chunk = u.get_next_chunk();
                if(next_chunk != -1) {
                    u.upload_chunk(next_chunk);
                } else {
                    if(u.upload_finished()) {
                        u.log("No next chunk; finish upload");
                        u.finish_upload();
                    }
                }
            }

            // the "readystatechange" handler
            var handler = function(e) {
                // we care about the "done" event triggered while processing
                if(e.target.readyState != DONE_STATE || u.get_state() != "processing") {
                    u.log(e);
                    return;
                }

                // if we don't receive a 2XX response, trigger an error
                if(e.target.status / 100 != 2) {
                    return error_handler(e);
                }

                // at this point, we know that this chunk finished uploading
                u.log("Chunk uploaded: " + chunk);

                // notify the server of the uploaded chunk
                u.notify_chunk_uploaded(chunk);

                // and also trigger the chunk_uploaded callback
                u.settings.on_chunk_uploaded.call(u, chunk);

                // cancel the xhr watcher interval
                clearInterval(u._intervals[chunk]);

                // mark the chunk as finished
                u.set_progress(chunk, u.get_chunk_size(chunk));
                u.set_chunk_finished(chunk);
                u.set_chunk_uploading(chunk, false);

                // get next chunk; if we're out of chunks,
                // finish the upload
                var next_chunk = u.get_next_chunk();
                if(next_chunk != -1) {
                    u.upload_chunk(next_chunk);
                } else if(u.upload_finished()) {
                    u.log("Done");
                    u.finish_upload();
                } else {
                    var interval = setInterval(function() {
                        var chunk = u.get_next_chunk();
                        if(chunk != -1) {
                            clearInterval(interval);
                            u.upload_chunk(chunk);
                        } else if(u.upload_finished()) {
                            clearInterval(interval);
                            u.finish_upload();
                        }
                    }, 1000);
                }
            };

            // the upload progress handler
            var progress_handler = function(e) {
                // set the internal chunk's progress value to the reported amount
                u.set_progress(chunk, e.loaded);

                // trigger the progress event callback
                u.settings.on_progress.call(u, u.get_total_progress(), u.file.size);

                // update the last_progress_time for the watcher interval
                last_progress_time = new Date();
            };
            var error_handled = false;
            var error_handler = function(e) {
                var error_arguments = arguments;
                var xhr = e.target;
                // the upload may have finished, so check for that
                u.check_already_uploaded(function() {
                    // if already uploaded
                    u.set_state("finished");

                    u.notify_upload_finished();

                    // trigger a final progress event callback, with 100%
                    u.settings.on_progress.call(u, u.file.size, u.file.size);

                    // also trigger the complete event callback
                    u.settings.on_complete.call(u);
                }, function() {
                    // we have a genuine error

                    u.log("Error: ");
                    u.log(error_arguments);

                    // make sure we don't handle the same error more than once
                    if(error_handled) {
                        return;
                    }
                    error_handled = true;

                    // abort the chunk upload
                    u.set_chunk_uploading(chunk, false);
                    u.set_chunk_finished(chunk, false);
                    u.set_progress(chunk, 0);
                    u.log("Abort");
                    try {
                        xhr.abort();
                    } catch(e) {
                        u.log(e);
                    }

                    u.log("Retry chunk: " + chunk);

                    // clear the watcher interval
                    clearInterval(u._intervals[chunk]);

                    // re-try the upload
                    setTimeout(function() {
                        if(u.get_state() == "processing") {
                            // and proceed
                            var next_chunk = u.get_next_chunk(chunk);
                            if(next_chunk !== -1) {
                                u.get_all_signatures(function() {
                                    u.upload_chunk(u.get_next_chunk());
                                });
                            }
                        }
                    }, 1000);
                });
            };


            // The chunk number is 0-indexed to simplify the calculations,
            // but S3 requires 1-indexed part numbers
            var path = "/" + u.settings.key;
            path += "?partNumber=" + (chunk + 1) + "&uploadId=" + u.upload_id;
            var method = "PUT";
            var authorization = "AWS " + u.settings.access_key + ":" + signature;
            var blob = u.file.slice(start, end);

            var xhr = XHR.call(u, {
                method: "PUT",
                url: u.settings.host + path,
                progress_callback: progress_handler,
                state_change_callback: handler,
                error_handler: error_handler,
                timeout_handler: error_handler,
                headers: {
                    "x-amz-date": date,
                    "Authorization": authorization,
                    "Content-Type": u.file.type || u.settings.content_type,
                    "Content-Disposition": "attachment; filename=" + u.file.name
                },
                body: blob
            });

            window.xhrs = window.xhrs || [];
            window.xhrs.push(xhr);

            u._chunk_xhr = u._chunk_xhr || [];
            u._chunk_xhr.push(xhr);


            // the watcher interval; it cancels the xhr if it times out
            u._intervals[chunk] = setInterval(function() {
                if(last_progress_time && (new Date() - last_progress_time) > 15000) { // 15s
                    u.log("Chunk Failed; retry");
                    clearInterval(u._intervals[chunk]);
                    if(u.get_state() == "processing") {
                        xhr.abort();
                        error_handler.call(xhr);
                    }
                }
            }, 4000); // every 4s
        });
    };

    // initiates the upload finish sequence
    Uploader.prototype.finish_upload = function() {
        var u = this;

        // make sure it's not triggered when not processing (e.g. multiple times)
        if(u.get_state() != "processing") {
            return;
        }

        // change the upload's state
        u.set_state("finishing");

        u.settings.on_progress.call(u, u.file.size, u.file.size); // 100% done.

        // we need the ending signature to put the chunks together
        u.get_end_signature(function(signature, date) {
            var path = "/" + u.settings.key + "?uploadId=" + u.upload_id;
            var method = "POST";
            var authorization = "AWS " + u.settings.access_key + ":" + signature;

            var handler = function(e) {
                // i.e. if it's a 2XX response
                if(e.target.status / 100 == 2) {
                    u.log("Finished file.");
                    u.set_state("finished");
                    u.settings.on_progress.call(u, u.file.size, u.file.size); // it's 100% done

                    u.notify_upload_finished();

                    // trigger the complete event callback
                    u.settings.on_complete.call(u);
                } else if(e.target.status == 400 &&
                        e.target.responseText.indexOf("EntityTooSmall") !== -1) {
                    // an "EntityTooSmall" error means that we missed a chunk
                    u.list_parts(function(parts) {
                        u.update_chunks(parts);
                        var next_chunk = u.get_next_chunk();
                        u.set_state("processing");
                        u.upload_chunk(next_chunk);
                    });
                } else if(e.target.status == 404) {
                    // 404 = NoSuchUpload = check if already finished
                    // if so, start a new upload
                    u.cancel(function() {
                        u.upload_file(u.file, true);
                    });
                } else {
                    u.check_already_uploaded(function() {
                        handler({
                            target: {
                                status: 200
                            }
                        });
                    }, function() {
                        handler({
                            target: {
                                status: 404
                            }
                        });
                    });
                }
            };

            // get the uploaded parts from S3
            u.list_parts(function(parts) {
                var num_chunks = Math.ceil(u.file.size / u.settings.chunk_size);

                // check that we uploaded all the chunks; if we didn't,
                // start uploading the missing ones
                if(parts.length != num_chunks) {
                    u.update_chunks(parts);
                    var next_chunk = u.get_next_chunk();
                    u.set_state("processing");
                    u.upload_chunk(next_chunk);
                    return;
                }

                // compose the CompleteMultipartUpload request for putting
                // the chunks together
                var data = "<CompleteMultipartUpload>";
                for(var i=0; i<parts.length; i++) {
                    data += "<Part>";
                    data += "<PartNumber>" + parts[i][0] + "</PartNumber>";
                    data += "<ETag>" + parts[i][1] + "</ETag>";
                    data += "</Part>";
                }
                data += "</CompleteMultipartUpload>";

                // firefox requires a small hack
                if(navigator.userAgent.indexOf("Firefox") !== -1) {
                    data = new Blob([data]);
                }

                // send the ajax request
                XHR.call(u, {
                    url: u.settings.host + path,
                    method: "POST",
                    load_callback: handler,
                    error_callback: handler,
                    headers: {
                        "x-amz-date": date,
                        "Authorization": authorization,
                        "Content-Type": u.file.type || u.settings.content_type,
                        "Content-Disposition": "attachment; filename=" + u.file.name
                    },
                    body: data
                });
            });
        });
    };

    // gets the uploaded chunks from S3. This is useful when comparing
    // the parts known by the uploader to the parts reported by S3, and also
    // for getting the chunk ETag's, which are needed when finishing uploads
    Uploader.prototype.list_parts = function(callback, error_callback, part_marker) {
        var u = this;
        u.get_list_signature(function(signature, date) {
            var handler = function(e) {
                // if it's not a 2XX response, trigger the error callback
                if(e.target.status / 100 != 2) {
                    if (error_callback) {
                        error_callback(e);
                    }
                    return;
                }

                // process the parts, and return an array of
                // [part_number, etag, size] through the given callback
                var xml = e.target.responseXML;
                var parts = [];
                var xml_parts = xml.getElementsByTagName("Part");
                var num_chunks = Math.ceil(u.file.size / u.settings.chunk_size);
                for(var i=0; i < xml_parts.length; i++) {
                    var part_number = parseInt(xml_parts[i].getElementsByTagName("PartNumber")[0].textContent, 10);
                    var etag = xml_parts[i].getElementsByTagName("ETag")[0].textContent;
                    var size = parseInt(xml_parts[i].getElementsByTagName("Size")[0].textContent, 10);

                    if(part_number != num_chunks && size != u.settings.chunk_size) {
                        continue; // chunk corrupted
                    } else if(part_number == num_chunks &&
                            size != u.file.size % u.settings.chunk_size) {
                        continue; // final chunk corrupted
                    }

                    parts.push([
                        part_number,
                        etag,
                        size
                    ]);
                }
                var is_truncated = xml.getElementsByTagName("IsTruncated")[0].textContent;
                if(is_truncated === "true") {
                    var part_marker = xml.getElementsByTagName("NextPartNumberMarker")[0].textContent;
                    u.list_parts(function(new_parts) {
                        callback(parts.concat(new_parts));
                    }, error_callback, part_marker);
                } else {
                    callback(parts);
                }
            };
            var path = "/" + u.settings.key + "?uploadId=" + u.upload_id;
            if(part_marker) {
                path = path + "&part-number-marker=" + part_marker;
            }
            var method = "GET";
            var authorization = "AWS " + u.settings.access_key + ":" + signature;
            XHR.call(u, {
                method: "GET",
                load_callback: handler,
                error_callback: handler,
                url: u.settings.host + path,
                headers: {
                    "x-amz-date": date,
                    "Content-Type": u.file.type || u.settings.content_type,
                    "Authorization": authorization
                }
            });
        });
    };

    // gets the end signature, needed for finishing an upload
    Uploader.prototype.get_end_signature = function(callback) {
        var u = this;

        // if we already have the signature, return that
        if(u._end_signature) {
            callback(u._end_signature[0], u._end_signature[1]);
            return;
        }
        var handler = function(e) {
            u.retry_count = 0;
            var response = JSON.parse(e.target.responseText);
            callback(response.signature, response.date);
        };
        var error_handler = function(e) {
            u.retry(e, function() {
                // if there's an error, retry after one second
                setTimeout(function() {
                    u.get_end_signature(callback);
                }, u.settings.retry_timeout);
            });
        };
        var url = u.settings.ajax_base + "/get_end_signature/?upload_id=" + escape(u.upload_id) +
            "&mime_type=" + escape(u.file.type || u.settings.content_type) +
            "&key=" + u.settings.key;

        XHR.call(u, {
            url: url,
            extra_params: u.settings.extra_params,
            load_callback: handler,
            error_callback: error_handler
        });
    };

    // gets the list signature, needed for listing the upload's chunks
    // see `Uploader.prototype.list_parts`
    Uploader.prototype.get_list_signature = function(callback, error_callback) {
        var u = this;
        error_callback = error_callback || function() {};

        // if we already have the signature, return that
        if(u._list_signature) {
            callback(u._list_signature[0], u._list_signature[1]);
            return;
        }
        var handler = function(e) {
            u.retry_count = 0;
            var response = JSON.parse(e.target.responseText);
            callback(response.signature, response.date);
        };
        var error_handler = function(e) {
            u.retry(e, function() {
                // if there's an error, retry after one second
                // (think server hiccups, internet connection temporarily
                // disabled, etc.)
                setTimeout(function() {
                    u.get_list_signature(callback);
                }, u.settings.retry_timeout);
            });
        };
        var url = u.settings.ajax_base + "/get_list_signature/?upload_id=" + escape(u.upload_id) +
            "&mime_type=" + escape(u.file.type || u.settings.content_type) +
            "&key=" + u.settings.key;
        XHR.call(u, {
            url: url,
            extra_params: u.settings.extra_params,
            load_callback: handler,
            error_callback: error_handler
        });
    };

    // gets the signature for one chunk upload
    Uploader.prototype.get_chunk_signature = function(chunk, callback) {
        var u = this;

        // if we already have the signature, return that.
        // note the 0-indexing vs 1-indexing between what we have locally and
        // what S3 gives us
        if(u._chunk_signatures && u._chunk_signatures[chunk + 1]) {
            callback(u._chunk_signatures[chunk + 1][0], u._chunk_signatures[chunk + 1][1]);
            return;
        }
        var handler = function(e) {
            u.retry_count = 0;
            var response = JSON.parse(e.target.responseText);
            callback(response.signature, response.date);
        };
        var error_handler = function(e) {
            u.retry(e, function() {
                // if there's an error, retry after one second
                setTimeout(function() {
                    u.get_chunk_signature(chunk, callback);
                }, u.settings.retry_timeout);
            });
        };
        var url = u.settings.ajax_base + "/get_chunk_signature/?chunk=" + (chunk + 1) +
            "&mime_type=" + escape(u.file.type || u.settings.content_type) +
            "&upload_id=" + escape(u.upload_id) +
            "&key=" + u.settings.key;
        XHR.call(u, {
            url: url,
            extra_params: u.settings.extra_params,
            load_callback: handler,
            error_callback: error_handler
        });
    };

    // gets the init signature, needed for starting an upload
    Uploader.prototype.get_init_signature = function(callback, force) {
        var u = this;
        var num_chunks = Math.ceil(u.file.size / u.settings.chunk_size);
        var handler = function(e) {
            if (e.target.status / 100 != 2) {
                error_handler(e);
                return;
            }
            u.retry_count = 0;
            var response = JSON.parse(e.target.responseText);

            // the server may also respond with chunks already loaded
            if(response.chunks) {
                if(response.chunks.length == num_chunks) {
                    return u.get_init_signature(callback, true);
                }
                u.log("Resume upload...");
                var chunks = response.chunks;
                u._progress = u._progress || [];
                for(var i=0; i < chunks.length; i++) {
                    u.log("Chunk already uploaded: " + (chunks[i] - 1));
                    var chunk_size = u.get_chunk_size(chunks[i]);
                    u._progress[chunks[i]] = chunk_size;
                    u._total_progress += chunk_size;

                    u.add_loaded_chunk(chunks[i] - 1);
                    u.set_chunk_finished(chunks[i] - 1);
                    u.bytes_started = (u.bytes_started || 0) + u.settings.chunk_size;
                }
                u.upload_id = response.upload_id;
                u.settings.key = response.key;
            }
            callback(response.signature, response.date);
        };
        var error_handler = function(e) {
            u.retry(e, function() {
                u.log("Failed; trying again");
                // if it fails, retry after waiting one second
                setTimeout(function() {
                    u.get_init_signature(callback);
                }, u.settings.retry_timeout);
            });
        };
        var url = u.settings.ajax_base + "/get_init_signature/?key=" + u.settings.key +
                "&mime_type=" + escape(u.file.type || u.settings.content_type) +
                "&filename=" + escape(u.file.name) +
                "&filesize=" + u.file.size +
                "&last_modified=" + u.file.lastModifiedDate.valueOf() +
                (force ? "&force=true" : "");
        XHR.call(u, {
            url: url,
            extra_params: u.settings.extra_params,
            load_callback: handler,
            error_callback: error_handler
        });
    };

    // gets all the signatures: init, list, chunks and finish
    // much more convenient than getting them one at a time
    Uploader.prototype.get_all_signatures = function(callback) {
        var u = this;
        var key = u.settings.key;
        var num_chunks = Math.ceil(u.file.size / u.settings.chunk_size);
        var upload_id = u.upload_id;
        var handler = function(e) {
            u.retry_count = 0;
            var response = JSON.parse(e.target.responseText);
            u._chunk_signatures = response.chunk_signatures;
            u._list_signature = response.list_signature;
            u._end_signature = response.end_signature;
            u._delete_signature = response.delete_signature;
            callback();
        };
        var error_handler = function() {
            u.retry(e, function() {
                // if it fails, wait one second and try again
                setTimeout(function() {
                    u.get_all_signatures(callback);
                }, u.settings.retry_timeout);
            });
        };
        var url = u.settings.ajax_base + "/get_all_signatures/?key=" + key +
                "&mime_type=" + escape(u.file.type || u.settings.content_type) +
                "&num_chunks=" + num_chunks +
                "&upload_id=" + upload_id +
                "&filename=" + escape(u.file.name) +
                "&filesize=" + u.file.size +
                "&last_modified=" + u.file.lastModifiedDate.valueOf();
        XHR.call(u, {
            url: url,
            extra_params: u.settings.extra_params,
            load_callback: handler,
            error_callback: error_handler
        });
    };

    // notify the server that a chunk finished uploading. This is needed for
    // upload resumes
    Uploader.prototype.notify_chunk_uploaded = function(chunk) {
        var u = this;
        if(u.get_state() != "processing") {
            return;
        }
        var key = u.settings.key;
        var upload_id = u.upload_id;
        var url = u.settings.ajax_base + '/chunk_loaded/?key=' + key + "&chunk=" + (chunk + 1) +
            "&upload_id=" + upload_id + "&filename=" + escape(u.file.name) +
            "&filesize=" + u.file.size + "&last_modified=" + u.file.lastModifiedDate.valueOf();
        XHR.call(u, {
            url: url,
            extra_params: u.settings.extra_params,
            error_callback: u.error_handler
        });
    };

    Uploader.prototype.notify_upload_finished = function(callback) {
        var u = this;
        if(u.get_state() != "finished") {
            return;
        }
        var key = u.settings.key;
        var upload_id = u.upload_id;
        var url = u.settings.ajax_base + '/upload_finished/?key=' + key +
            "&upload_id=" + upload_id + "&filename=" + escape(u.file.name) +
            "&filesize=" + u.file.size + "&last_modified=" + u.file.lastModifiedDate.valueOf();
        XHR.call(u, {
            url: url,
            extra_params: u.settings.extra_params,
            error_callback: u.error_handler
        });
    };

    // check whether the file is already uploaded
    Uploader.prototype.check_already_uploaded = function(callback, error_callback) {
        var u = this;
        var method = "HEAD";
        var path = "/" + u.settings.key;
        var inner_handler = function(e) {
            // the handler only checks for status code;
            // if the HEAD returns 404, re-upload,
            // else, it returns 200 and finish the upload
            if(e.target.status / 100 == 2) {
                u.retry_count = 0;
                u.log("Already Uploaded");
                callback();
            } else {
                u.log("Error!");
                error_callback();
            }
        };

        if(!error_callback && typeof(error_callback) !== "function") {
            error_callback = function() {
                u.retry(e, function() {
                    setTimeout(function() {
                        return u.check_already_uploaded(callback, error_callback);
                    }, 2500);
                });
            };
        }

        XHR.call(u, {
            url: u.settings.host + path,
            method: "HEAD",
            load_callback: inner_handler,
            error_callback: error_callback
        });
    };

    // cancels an upload
    Uploader.prototype.cancel = function(callback) {
        // empty all fields, cancel all intervals, abort all xhr's
        var u = this;
        for(var i=0; i < u._chunk_xhr.length; i++) {
            u.log("Abort chunk: " + u._chunk_xhr[i]);
            u._chunk_xhr[i].abort();
        }
        u._intervals = u._intervals || {};
        for(var x in u._intervals) {
            clearInterval(u._intervals[x]);
        }
        callback = callback || function() {};
        u.set_state("canceled");
        u._chunk_xhr = u._chunk_xhr || [];
        u.settings.on_progress.call(u, 0, 0);
        u._chunk_xhr = null;
        u._chunks = null;
        u._uploading_chunks = null;
        u._loaded_chunks = null;
        u._start_fired = false;
        u.upload_id = null;
        u._progress = null;
        u._chunk_signatures = null;
        u._list_signature = null;
        u._end_signature = null;
        u._delete_signature = null;
        u.set_state("waiting"); // wait for a new upload
        callback();
    };

    // updates the chunk history with the given chunks
    Uploader.prototype.update_chunks = function(parts) {
        var u = this;
        var loaded = [];
        var num_chunks = Math.ceil(u.file.size / u.settings.chunk_size);
        var i;

        u._init_chunks(true);
        u._uploading_chunks = [];
        u._loaded_chunks = [];

        for(i=0; i < parts.length; i++) {
            var part_number = parseInt(parts[i][0], 10);
            u.add_loaded_chunk(part_number - 1);
            u.set_chunk_finished(part_number - 1);
            loaded.push(part_number - 1);
        }
        for(i=0; i < num_chunks; i++) {
            if(loaded.indexOf(i) === -1) {
                u.log("Chunk not uploaded: ", i);
                u.set_progress(i, 0);
            }
        }
    };

    // returns true if a file is selected
    Uploader.prototype.is_selected = function() {
        return !!this.file;
    };

    // returns the uploader's state
    Uploader.prototype.get_state = function() {
        return this._state;
    };

    // sets the uploader's state
    Uploader.prototype.set_state = function(state) {
        this._state = state;
        return this._state;
    };

    // set a chunk's progress
    Uploader.prototype.set_progress = function(chunk, loaded) {
        var u = this;
        var num_chunks = Math.ceil(u.file.size / u.settings.chunk_size);
        u.log_status();
        u._progress = u._progress || {};
        u._total_progress = (u._total_progress || 0 ) + loaded - (u._progress[chunk] || 0);
        u._progress[chunk] = loaded;
        u.settings.on_chunk_progress.call(
            u, chunk, loaded, u.get_chunk_size(chunk));
    };

    // gets the total bytes uploaded
    Uploader.prototype.get_total_progress = function() {
        return this._total_progress || 0;
    };

    // returns true if a chunk is already uploaded
    Uploader.prototype.is_chunk_loaded = function(chunk) {
        this._loaded_chunks = this._loaded_chunks || [];
        return this._loaded_chunks.indexOf(chunk) !== -1;
    };

    // adds a chunk to the uploaded list
    Uploader.prototype.add_loaded_chunk = function(chunk) {
        this._loaded_chunks = this._loaded_chunks || [];
        this._loaded_chunks.push(chunk);
        this.set_progress(chunk, this.get_chunk_size(chunk));
    };

    // returns true if the chunk is currently uploading
    Uploader.prototype.get_chunk_uploading = function(chunk) {
        this._uploading_chunks = this._uploading_chunks || [];
        return this._uploading_chunks.indexOf(chunk) !== -1;
    };

    // sets whether a chunk is currently uploading or not
    Uploader.prototype.set_chunk_uploading = function(chunk, val) {
        if(typeof val == "undefined") {
            val = true;
        }
        this._uploading_chunks = this._uploading_chunks || [];
        if(val) {
            this._uploading_chunks.push(chunk);
        } else {
            var list = [];
            for(var i=0; i < this._uploading_chunks.length; i++) {
                if(this._uploading_chunks[i] != chunk) {
                    list.push(this._uploading_chunks[i]);
                }
            }
            this._uploading_chunks = list;
        }
    };

    // initialize inner representation of chunks
    Uploader.prototype._init_chunks = function(force) {
        var u = this;
        if(!u._chunks || force) {
            u._chunks = [];
            var num_chunks = Math.ceil(u.file.size / u.settings.chunk_size);
            for(var i=0; i < num_chunks; i++) {
                u._chunks.push(false);
            }
        }
    };

    // sets whether a chunk finished uploading
    Uploader.prototype.set_chunk_finished = function(chunk, val) {
        if(typeof val == "undefined") {
            val = true;
        }
        var u = this;
        u._init_chunks();
        u._chunks[chunk] = val;
    };

    // get next chunk to be uploaded; if all chunks are done, return -1
    Uploader.prototype.get_next_chunk = function(chunk) {
        var u = this;
        u._init_chunks();
        if(chunk && !u._chunks[chunk] && !u.get_chunk_uploading(chunk)) {
            return chunk;
        }
        for(var i=0; i < u._chunks.length; i++) {
            if(!u._chunks[i] && !u.get_chunk_uploading(i)) {
                return i;
            }
        }
        return -1;
    };

    // returns true if all chunks finished uploaded
    Uploader.prototype.upload_finished = function() {
        var u = this;
        u._init_chunks();
        for(var i=0; i < u._chunks.length; i++) {
            if(!u._chunks[i] || u.get_chunk_uploading(i)) {
                return false;
            }
        }
        return true;
    };

    Uploader.prototype.is_last_chunk = function(chunk) {
        return Math.ceil(this.file.size / this.settings.chunk_size) == chunk - 1;
    };

    Uploader.prototype.get_chunk_size = function(chunk) {
        if(this.is_last_chunk(chunk)) {
            return this.file.size % this.settings.chunk_size;
        } else {
            return this.settings.chunk_size;
        }
    };

    Uploader.prototype.log_status = function() {
        // var u = this;
        // u.log(this.get_total_progress() / this.file.size * 100);
    };

    Uploader.prototype.set_max_size = function(max_size) {
        this.settings.max_size = max_size || 0;
    };

    Uploader.prototype.error_handler = function(e) {
        this.settings.on_error.call(this, e);
    };

    Uploader.prototype.retry = function(e, f) {
        var u = this;
        // if we've exceeded our retry count, permanently fail
        if (u.retry_count > u.settings.retry_limit) {
            u.retry_count = 0;
            u.error_handler(e);
            return;
        }
        u.retry_count++;
        f();
    };

    Uploader.prototype.file_equals = function(file) {
        var u = this;
        if (
            u.file.lastModifiedDate.toString() === file.lastModifiedDate.toString() &&
            u.file.name === file.name &&
            u.file.type === file.type &&
            u.file.size === file.size
            ) {
            return true;
        }
        return false;
    };

    Uploader.prototype.on_chunk_progress = function(f) { u.settings.on_chunk_progress = f; };
    Uploader.prototype.on_progress = function(f) { u.settings.on_progress = f; };
    Uploader.prototype.on_select = function(f) { u.settings.on_select = f; };
    Uploader.prototype.on_error = function(f) { u.settings.on_error = f; };
    Uploader.prototype.on_complete = function(f) { u.settings.on_complete = f; };
    Uploader.prototype.on_init = function(f) { u.settings.on_init = f; };
    Uploader.prototype.on_start = function(f) { u.settings.on_start = f; };
    Uploader.prototype.on_chunk_uploaded = function(f) { u.settings.on_chunk_uploaded = f; };

    //** END Uploader Class **//

})();