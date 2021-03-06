// Load modules

var Boom = require('boom');
var Oz = require('./oz');
var Hawk = require('./hawk');
var Bewit = require('./bewit');
var Basic = require('./basic');
var Cookie = require('./cookie');
var Utils = require('../utils');


// Declare internals

var internals = {};


exports = module.exports = internals.Auth = function (server) {

    Utils.assert(this.constructor === internals.Auth, 'Auth must be instantiated using new');

    this.server = server;

    // Load strategies

    this._strategies = {};
    this._extensions = [];
    this._requiredByDefault = null;         // Strategy name used as default if route has no auth settings

    return this;
};


internals.Auth.prototype.add = function (name, options) {

    Utils.assert(name, 'Authentication strategy must have a name');
    Utils.assert(!this._strategies[name], 'Authentication strategy name already exists');
    Utils.assert(options && typeof options === 'object', 'Invalid strategy options');
    Utils.assert(!options.scheme || ['oz', 'basic', 'hawk', 'cookie', 'bewit'].indexOf(options.scheme) !== -1, name + ' has an unknown scheme: ' + options.scheme);
    Utils.assert(options.scheme || options.implementation, name + ' missing both scheme and extension implementation');
    Utils.assert(!options.implementation || (typeof options.implementation === 'object' && typeof options.implementation.authenticate === 'function'), name + ' has invalid extension scheme implementation');
    Utils.assert(!options.requiredByDefault || !this._requiredByDefault, 'Cannot set default required strategy more than once: ' + name + ' (already set to: ' + this._requiredByDefault + ')');

    options.scheme = options.scheme || 'ext';
    switch (options.scheme) {
        case 'oz': this._strategies[name] = new Oz(this.server, options); break;
        case 'hawk': this._strategies[name] = new Hawk(this.server, options); break;
        case 'basic': this._strategies[name] = new Basic(this.server, options); break;
        case 'cookie': this._strategies[name] = new Cookie(this.server, options); break;
        case 'bewit': this._strategies[name] = new Bewit(this.server, options); break;
        default: this._strategies[name] = options.implementation; break;
    }

    if (this._strategies[name].extend &&
        typeof this._strategies[name].extend === 'function') {

        this._extensions.push(this._strategies[name]);
    }

    if (options.requiredByDefault) {
        this._requiredByDefault = name;
    }
};


internals.Auth.prototype.addBatch = function (options) {

    var self = this;

    Utils.assert(options && typeof options === 'object', 'Invalid auth options');

    if (!Object.keys(options).length) {
        return;
    }

    Utils.assert(!!options.scheme ^ !!options.implementation ^ !!options[Object.keys(options)[0]].scheme ^ !!options[Object.keys(options)[0]].implementation, 'Auth options must include either a top level strategy or object of strategies but not both');
    var settings = ((options.scheme || options.implementation) ? { 'default': options } : options);

    Object.keys(settings).forEach(function (strategy) {

        self.add(strategy, settings[strategy]);
    });
};


internals.Auth.prototype.setupRoute = function (options) {

    var self = this;

    if (options === false) {
        return false;
    }

    if (typeof options === 'string') {
        options = { strategy: options };
    }

    if (!options) {
        return false;
    }

    options.mode = options.mode || 'required';
    Utils.assert(['required', 'optional', 'try'].indexOf(options.mode) !== -1, 'Unknown authentication mode: ' + options.mode);

    Utils.assert(!options.entity || ['user', 'app', 'any'].indexOf(options.entity) !== -1, 'Unknown authentication entity type: ' + options.entity);
    Utils.assert(!options.payload || ['required', 'optional'].indexOf(options.payload) !== -1, 'Unknown authentication payload mode: ' + options.entity);
    Utils.assert(!(options.strategy && options.strategies), 'Route can only have a auth.strategy or auth.strategies (or use the default) but not both');
    Utils.assert(!options.strategies || options.strategies.length, 'Cannot have empty auth.strategies array');
    options.strategies = options.strategies || [options.strategy || 'default'];
    delete options.strategy;

    options.payload = options.payload || false;
    var hasAuthenticatePayload = false;
    options.strategies.forEach(function (strategy) {

        Utils.assert(self._strategies[strategy], 'Unknown authentication strategy: ' + strategy);
        hasAuthenticatePayload = hasAuthenticatePayload || typeof self._strategies[strategy].authenticatePayload === 'function';
        Utils.assert(options.payload !== 'required' || hasAuthenticatePayload, 'Payload validation can only be required when all strategies support it');
    });

    Utils.assert(!options.payload || hasAuthenticatePayload, 'Payload authentication requires at least one strategy with payload support');

    return options;
};


internals.Auth.prototype.routeConfig = function (request) {

    var settings = request.route.auth;
    if (settings) {
        return settings;
    }

    if (this._requiredByDefault) {
        return {
            mode: 'required',
            strategies: [this._requiredByDefault]
        };
    }

    return false;
};


internals.Auth.authenticate = function (request, next) {

    var auth = request.server._auth;
    var config = auth.routeConfig(request);
    if (!config) {
        return next();
    }

    // Extend requests with loaded strategies

    for (var i = 0, il = auth._extensions.length; i < il; ++i) {
        auth._extensions[i].extend(request);
    }

    return auth.authenticate(request, next);
};


internals.Auth.prototype.authenticate = function (request, next) {

    var self = this;

    var config = this.routeConfig(request);

    var authErrors = [];
    var strategyPos = 0;

    request.isAuthenticated = false;

    var authenticate = function () {

        // Injection

        if (request.session) {
            return validate(null, request.session);
        }

        // Authenticate

        if (strategyPos >= config.strategies.length) {

            if (config.mode === 'optional' ||
                config.mode === 'try') {

                request.session = null;
                request.log(['auth', 'unauthenticated']);
                return next();
            }

            return next(Boom.unauthorized('Missing authentication', authErrors));
        }

        var strategy = self._strategies[config.strategies[strategyPos++]];           // Increments counter after fetching current strategy
        return strategy.authenticate(request, validate);
    };

    var validate = function (err, session, wasLogged) {

        // Unauthenticated

        if (!err && !session) {
            return next(Boom.internal('Authentication response missing both error and session'));
        }

        if (err) {
            if (!wasLogged) {
                request.log(['auth', 'unauthenticated'], err);
            }

            if (err instanceof Error === false ||                                   // Not an actual error (e.g. redirect, custom response)
                !err.isMissing ||                                                   // Missing authentication (did not fail)
                err.response.code !== 401) {                                        // An actual error (not just missing authentication)

                if (config.mode === 'try') {
                    request.session = session;
                    request.log(['auth', 'unauthenticated', 'try'], err);
                    return next();
                }

                return next(err);
            }

            // Try next strategy

            if (err.response.headers['WWW-Authenticate']) {
                authErrors.push(err.response.headers['WWW-Authenticate']);
            }

            return authenticate();
        }

        // Authenticated

        request.session = session;
        request.session._strategy = self._strategies[config.strategies[strategyPos - 1]];

        // Check scope

        if (config.scope &&
            (!session.scope || session.scope.indexOf(config.scope) === -1)) {

            request.log(['auth', 'error', 'scope'], { got: session.scope, need: config.scope });
            return next(Boom.forbidden('Insufficient scope (\'' + config.scope + '\' expected)'));
        }

        // Check TOS

        var tos = (config.hasOwnProperty('tos') ? config.tos : null);
        if (tos &&
            (!session.ext || !session.ext.tos || session.ext.tos < tos)) {

            request.log(['auth', 'error', 'tos'], { min: tos, received: session.ext && session.ext.tos });
            return next(Boom.forbidden('Insufficient TOS accepted'));
        }

        // Check entity

        var entity = config.entity || 'any';

        // Entity: 'any'

        if (entity === 'any') {
            request.log(['auth']);
            request.isAuthenticated = true;
            return next();
        }

        // Entity: 'user'

        if (entity === 'user') {
            if (!session.user) {
                request.log(['auth', 'error'], 'User session required');
                return next(Boom.forbidden('Application session cannot be used on a user endpoint'));
            }

            request.log(['auth']);
            request.isAuthenticated = true;
            return next();
        }

        // Entity: 'app'

        if (session.user) {
            request.log(['auth', 'error'], 'App session required');
            return next(Boom.forbidden('User session cannot be used on an application endpoint'));
        }

        request.log(['auth']);
        request.isAuthenticated = true;
        return next();
    };

    authenticate();
};


internals.Auth.authenticatePayload = function (request, next) {

    var auth = request.server._auth;
    var config = auth.routeConfig(request);

    if (!config ||
        !config.payload ||
        !request.isAuthenticated) {

        return next();
    }

    if (config.payload === 'optional' &&
        (!request.session.artifacts.hash ||
        typeof request.session._strategy.authenticatePayload !== 'function')) {

        return next();
    }

    request.session._strategy.authenticatePayload(request.rawBody, request.session, request.raw.req.headers['content-type'], function (err) {

        return next(err);
    });
};


internals.Auth.responseHeader = function (request, next) {

    var auth = request.server._auth;
    var config = auth.routeConfig(request);

    if (!config ||
        !request.isAuthenticated) {

        return next();
    }

    if (!request.session ||
        !request.session._strategy ||
        typeof request.session._strategy.responseHeader !== 'function') {

        return next();
    }

    if (!request.response ||
        request.response.isBoom ||
        request.response.varieties.error) {

        return next();
    }

    request.session._strategy.responseHeader(request, function (err) {

        return next(err);
    });
};