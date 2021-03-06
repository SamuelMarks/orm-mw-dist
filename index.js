"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Redis = require("ioredis");
const sequelize = require("sequelize");
const typeorm = require("typeorm");
const Waterline = require("waterline");
const async_1 = require("async");
const nodejs_utils_1 = require("nodejs-utils");
const populateModels = (program, omit_models, norm_set, waterline_set, typeorm_map, sequelize_map) => Object
    .keys(program)
    .filter(entity => program[entity] != null && omit_models.indexOf(entity) === -1)
    .forEach(entity => {
    if (program[entity].identity || program[entity].tableName)
        waterline_set.add(program[entity]);
    else if (typeof program[entity] === 'function')
        if (program[entity].toString().indexOf('sequelize') > -1)
            sequelize_map.set(entity, program[entity]);
        else if (program[entity].toString().indexOf('class') > -1)
            typeorm_map.set(entity, program[entity]);
        else
            norm_set.add(entity);
    else
        norm_set.add(entity);
});
const redisHandler = (orm, logger, callback) => {
    if (orm.skip)
        return callback(void 0);
    const cursor = new Redis(orm.config);
    cursor.on('error', err => {
        logger.error(`Redis::error event - ${cursor['options']['host']}:${cursor['options']['port']} - ${err}`);
        logger.error(err);
        return callback(err);
    });
    cursor.on('connect', () => {
        logger.info(`Redis client connected to:\t ${cursor['options']['host']}:${cursor['options']['port']}`);
        return callback(void 0, { connection: cursor });
    });
};
const sequelizeHandler = (orm, logger, callback) => {
    if (orm.skip)
        return callback(void 0);
    logger.info('Sequelize initialising with:\t', Array.from(orm.map.keys()), ';');
    const sequelize_obj = new sequelize['Sequelize'](orm.uri, orm.config);
    const entities = new Map();
    for (const [entity, program] of orm.map)
        entities.set(entity, program(sequelize_obj, orm.map));
    sequelize_obj
        .authenticate()
        .then(() => async_1.map(Array.from(entities.keys()), (entity_name, cb) => sequelize_obj
        .sync(entities.get(entity_name))
        .then(_ => cb(void 0))
        .catch(cb), err => callback(err, { connection: sequelize_obj, entities })))
        .catch(callback);
};
const typeormHandler = (orm, logger, callback) => {
    if (orm.skip)
        return callback(void 0);
    logger.info('TypeORM initialising with:\t', Array.from(orm.map.keys()), ';');
    try {
        return typeorm.createConnection(Object.assign({
            entities: Array.from(orm.map.values())
        }, orm.config)).then(connection => callback(null, { connection })).catch(callback);
    }
    catch (e) {
        return callback(e);
    }
};
const waterlineHandler = (orm, logger, callback) => {
    if (orm.skip)
        return callback(void 0);
    const waterline_obj = new Waterline();
    Array
        .from(orm.set.values())
        .forEach(e => waterline_obj.loadCollection(Waterline.Collection.extend(e)));
    waterline_obj.initialize(orm.config, (err, ontology) => {
        if (err != null)
            return callback(err);
        else if (ontology == null || ontology.connections == null || ontology.collections == null
            || ontology.connections.length === 0 || ontology.collections.length === 0) {
            logger.error('waterline_obj.initialize::ontology =', ontology, ';');
            return callback(new TypeError('Expected ontology with connections & waterline_collections'));
        }
        logger.info('Waterline initialised with:\t', Object.keys(ontology.collections), ';');
        return callback(null, { datastore: ontology.connections, collections: ontology.collections });
    });
};
exports.tearDownRedisConnection = (connection, done) => connection == null ? done(void 0) : done(connection.disconnect());
exports.tearDownSequelizeConnection = (connection, done) => connection == null ? done(void 0) : done(connection.close());
exports.tearDownTypeOrmConnection = (connection, done) => connection == null || !connection.isConnected ? done(void 0) : connection.close().then(_ => done()).catch(done);
exports.tearDownWaterlineConnection = (connections, done) => connections ? async_1.parallel(Object.keys(connections).map(connection => connections[connection]._adapter.teardown), () => {
    Object.keys(connections).forEach(connection => {
        if (['sails-tingo', 'waterline-nedb'].indexOf(connections[connection]._adapter.identity) < 0)
            connections[connection]._adapter.connections.delete(connection);
    });
    return done();
}) : done();
exports.tearDownConnections = (orms, done) => orms == null ? done(void 0) : async_1.parallel({
    redis: cb => exports.tearDownRedisConnection((orms.redis || { connection: undefined }).connection, cb),
    sequelize: cb => exports.tearDownSequelizeConnection((orms.sequelize || { connection: undefined }).connection, cb),
    typeorm: cb => exports.tearDownTypeOrmConnection((orms.typeorm || { connection: undefined }).connection, cb),
    waterline: cb => exports.tearDownWaterlineConnection((orms.waterline || { connection: undefined }).connection, cb)
}, done);
exports.ormMw = (options) => {
    const norm = new Set();
    const waterline_set = new Set();
    const typeorm_map = new Map();
    const sequelize_map = new Map();
    const do_models = options.orms_in == null ? false : Object
        .keys(options.orms_in)
        .filter(orm => orm !== 'Redis')
        .some(orm => options.orms_in[orm].skip === false);
    if (!do_models) {
        options.logger.warn('Not registering any ORMs or cursors');
        const mw = (req, res, next) => next();
        if (options.callback == null)
            return mw;
        return options.callback(void 0, mw, {});
    }
    if (!(options.models instanceof Map))
        options.models = nodejs_utils_1.model_route_to_map(options.models);
    for (const [fname, program] of options.models)
        if (program != null && fname.indexOf('model') > -1 && do_models)
            populateModels(program, options.omit_models || ['AccessToken'], norm, waterline_set, typeorm_map, sequelize_map);
    options.logger.warn('Failed registering models:\t', Array.from(norm.keys()), ';');
    async_1.parallel({
        redis: cb => options.orms_in.redis == null ? cb(void 0) :
            redisHandler(options.orms_in.redis, options.logger, cb),
        sequelize: cb => options.orms_in.sequelize == null ? cb(void 0) :
            sequelizeHandler(Object.assign(options.orms_in.sequelize, { map: sequelize_map }), options.logger, cb),
        typeorm: cb => options.orms_in.typeorm == null ? cb(void 0) :
            typeormHandler(Object.assign(options.orms_in.typeorm, { map: typeorm_map }), options.logger, cb),
        waterline: cb => options.orms_in.waterline == null ? cb(void 0) :
            waterlineHandler(Object.assign(options.orms_in.waterline, { set: waterline_set }), options.logger, cb),
    }, (err, orms_out) => {
        if (err != null) {
            if (options.callback != null)
                return options.callback(err);
            throw err;
        }
        const mw = (req, res, next) => {
            req.getOrm = () => orms_out;
            req.orms_out = orms_out;
            return next();
        };
        if (options.callback == null)
            return mw;
        return options.callback(void 0, mw, orms_out);
    });
};
