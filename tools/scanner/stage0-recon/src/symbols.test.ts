/** Tests for the tree-sitter symbol table (symbols.ts). Run: npx tsx src/symbols.test.ts */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { initSymbolParsers, extractFileSymbols, extractSymbolTable, SYMBOL_GRAMMARS } from './symbols.js'
import { exportedNames, type FileSymbols, type InventoryEntry, type SymbolKind } from './recon-contract.js'
import { makeReadGuard, SEED_DENYLIST } from '../../shared/read-guard.js'
import { resolveRunContext, REPO_ROOT } from '../../shared/run-context.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

await initSymbolParsers()

/** Fixtures are line arrays so each assertion's line number is the array index + 1. */
function parse(language: string, relPath: string, lines: string[]): FileSymbols {
  const fsym = extractFileSymbols(lines.join('\n'), language, relPath)
  if (!fsym) throw new Error(`no grammar for ${language}`)
  return fsym
}

function sym(f: FileSymbols, name: string, container?: string) {
  return f.symbols.find((s) => s.name === name && (container === undefined || s.container === container))
}

/** name has this kind, starts on this line and has this exported flag (and container, when given). */
function is(f: FileSymbols, name: string, kind: SymbolKind, line: number, exported: boolean, container?: string): boolean {
  const s = sym(f, name, container)
  return !!s && s.kind === kind && s.line === line && s.exported === exported && (container === undefined || s.container === container)
}

function imported(f: FileSymbols, source: string, names?: string[], line?: number): boolean {
  return f.imports.some((i) =>
    i.source === source &&
    (names === undefined || JSON.stringify(i.names) === JSON.stringify(names)) &&
    (line === undefined || i.line === line))
}

function absent(f: FileSymbols, name: string): boolean {
  return !f.symbols.some((s) => s.name === name)
}

// ---------------------------------------------------------------------------
console.log('\n-- javascript: CommonJS and ES exports --')
{
  const f = parse('javascript', 'lib/store.js', [
    "'use strict'",                                         // 1
    "const express = require('express')",                   // 2
    "const { promisify, inspect: show } = require('util')", // 3
    "import path from 'path'",                              // 4
    "import { readFile as rf, stat } from 'fs'",            // 5
    "import * as ns from './ns'",                           // 6
    '',                                                     // 7
    'function helper (a) { return a }',                     // 8
    "const handler = (req, res) => res.send('ok')",         // 9
    'const plain = 42',                                     // 10
    'class Store extends Base {',                           // 11
    '  async get (key) { return key }',                     // 12
    '}',                                                    // 13
    'exports.loose = function () {}',                       // 14
    'module.exports.Store = Store',                         // 15
    'module.exports = { helper, renamed: plain }',          // 16
    'export default function defaultFn () {}',              // 17
    'export { handler as aliased }',                        // 18
    "export { x as y } from './other'",                     // 19
  ])
  check('parses cleanly', f.grammar === 'javascript' && !f.parse_error)
  check('module.exports = { helper } exports a function', is(f, 'helper', 'function', 8, true))
  check('export { handler as aliased } -> aliased, at handler', is(f, 'aliased', 'function', 9, true))
  check('...and handler itself stays unexported', is(f, 'handler', 'function', 9, false))
  check('module.exports = { renamed: plain } -> renamed constant', is(f, 'renamed', 'constant', 10, true))
  check('plain non-exported constant is not a symbol', absent(f, 'plain'))
  check('module.exports.Store = Store exports the class', is(f, 'Store', 'class', 11, true))
  check('class method has container, never exported', is(f, 'get', 'method', 12, false, 'Store'))
  check('exports.loose = function', is(f, 'loose', 'function', 14, true))
  check('export default function X', is(f, 'defaultFn', 'function', 17, true))
  check('re-export export { x as y } from -> y', is(f, 'y', 'variable', 19, true))
  check('require binding', imported(f, 'express', ['express'], 2))
  check('require destructuring binds local names', imported(f, 'util', ['promisify', 'show'], 3))
  check('ES default import', imported(f, 'path', ['path'], 4))
  check('ES named import binds alias', imported(f, 'fs', ['rf', 'stat'], 5))
  check('ES namespace import', imported(f, './ns', ['ns'], 6))
  check('re-export is an import of its source', imported(f, './other', ['x'], 19))

  const g = parse('javascript', 'lib/main.js', [
    'function main () {}',      // 1
    'const unused = () => 1',   // 2
    'module.exports = main',    // 3
  ])
  check('module.exports = X exports X', is(g, 'main', 'function', 1, true) && is(g, 'unused', 'function', 2, false))
}

console.log('\n-- typescript: Juice-Shop-style exports --')
{
  const f = parse('typescript', 'lib/insecurity.ts', [
    "import { type Request, type Response, type NextFunction } from 'express'", // 1
    "import * as utils from '../lib/utils'",                                    // 2
    "import challengeUtils = require('../lib/challengeUtils')",                 // 3
    '',                                                                         // 4
    'export const isAuthorized = () => expressJwt(({ secret: publicKey }) as any)', // 5
    "export const roles = { customer: 'customer', admin: 'admin' }",            // 6
    '',                                                                         // 7
    'export function login () {',                                               // 8
    '  return (req: Request, res: Response, next: NextFunction) => {',         // 9
    '    next()',                                                               // 10
    '  }',                                                                      // 11
    '}',                                                                        // 12
    '',                                                                         // 13
    'export interface ResponseWithUser { status?: string }',                   // 14
    'export type Handler = (req: Request) => void',                            // 15
    "export enum Role { Admin = 'admin' }",                                     // 16
    'interface Internal { x: string }',                                        // 17
    'export class UserModel extends Model {',                                  // 18
    '  private secret (): void {}',                                            // 19
    '}',                                                                        // 20
    'export default async function retrieveCode () {}',                        // 21
    'const local = async () => {}',                                            // 22
  ])
  check('parses cleanly with the typescript grammar', f.grammar === 'typescript' && !f.parse_error)
  check('export const isAuthorized = () => ...', is(f, 'isAuthorized', 'function', 5, true))
  check('export const of a plain value is a constant', is(f, 'roles', 'constant', 6, true))
  check('export function login () {', is(f, 'login', 'function', 8, true))
  check('login spans its body', sym(f, 'login')?.end_line === 12)
  check('export interface', is(f, 'ResponseWithUser', 'interface', 14, true))
  check('export type', is(f, 'Handler', 'type', 15, true))
  check('export enum', is(f, 'Role', 'enum', 16, true))
  check('non-exported interface', is(f, 'Internal', 'interface', 17, false))
  check('export class', is(f, 'UserModel', 'class', 18, true))
  check('class method', is(f, 'secret', 'method', 19, false, 'UserModel'))
  check('export default async function', is(f, 'retrieveCode', 'function', 21, true))
  check('non-exported arrow function', is(f, 'local', 'function', 22, false))
  check('type-only named imports', imported(f, 'express', ['Request', 'Response', 'NextFunction'], 1))
  check('namespace import', imported(f, '../lib/utils', ['utils'], 2))
  check('import x = require()', imported(f, '../lib/challengeUtils', ['challengeUtils'], 3))
  check('exportedNames(): runtime names only', JSON.stringify([...exportedNames(f)].sort()) ===
    JSON.stringify(['Role', 'UserModel', 'isAuthorized', 'login', 'retrieveCode', 'roles']))
  // A TypeScript interface or type alias is exported in the table but erased at
  // runtime, so no route can call it; an enum and a class are runtime values.
  const names = exportedNames(f)
  check('exported interface: in the table, absent from exportedNames()',
    sym(f, 'ResponseWithUser')?.exported === true && !names.has('ResponseWithUser'))
  check('exported type alias: in the table, absent from exportedNames()',
    sym(f, 'Handler')?.exported === true && !names.has('Handler'))
  check('exported enum and class stay in exportedNames()', names.has('Role') && names.has('UserModel'))
}

console.log('\n-- tsx --')
{
  const f = parse('typescript', 'frontend/src/Profile.tsx', [
    "import React, { useState } from 'react'",                       // 1
    '',                                                               // 2
    'export function Profile ({ html }: { html: string }) {',        // 3
    '  const [open] = useState(false)',                               // 4
    '  return <div dangerouslySetInnerHTML={{ __html: html }} />',   // 5
    '}',                                                              // 6
    '',                                                               // 7
    'export const Badge = () => <span>ok</span>',                    // 8
    'const Hidden = () => <i />',                                    // 9
  ])
  check('.tsx uses the tsx grammar and parses JSX', f.grammar === 'tsx' && !f.parse_error)
  check('exported component function', is(f, 'Profile', 'function', 3, true))
  check('exported arrow component', is(f, 'Badge', 'function', 8, true))
  check('local component', is(f, 'Hidden', 'function', 9, false))
  check('default + named import', imported(f, 'react', ['React', 'useState'], 1))
}

console.log('\n-- python: Flask --')
{
  const f = parse('python', 'app/views.py', [
    'import os',                                   // 1
    'import os.path as osp, sys',                  // 2
    'from flask import Flask, request as req',     // 3
    'from . import models',                        // 4
    'from ..db import *',                          // 5
    '',                                            // 6
    'app = Flask(__name__)',                       // 7
    'handler = lambda x: x',                       // 8
    '',                                            // 9
    '@app.route("/login", methods=["POST"])',      // 10
    'def login():',                                // 11
    '    return "ok"',                             // 12
    '',                                            // 13
    'async def _private_helper(a):',               // 14
    '    import json',                             // 15
    '    return a',                                // 16
    '',                                            // 17
    'class UserView(MethodView):',                 // 18
    '    def get(self, user_id):',                 // 19
    '        return user_id',                      // 20
    '',                                            // 21
    '    class Meta:',                             // 22
    '        model = "User"',                      // 23
    '',                                            // 24
    'if TYPE_CHECKING:',                           // 25
    '    def typed() -> None: ...',                // 26
  ])
  check('parses cleanly', f.grammar === 'python' && !f.parse_error)
  check('decorated function: line of def, exported', is(f, 'login', 'function', 11, true))
  check('decorated function spans its body', sym(f, 'login')?.end_line === 12)
  check('leading underscore is not exported', is(f, '_private_helper', 'function', 14, false))
  check('module-level lambda is a function', is(f, 'handler', 'function', 8, true))
  check('plain module-level assignment is not a symbol', absent(f, 'app'))
  check('class', is(f, 'UserView', 'class', 18, true))
  check('method with container, not exported', is(f, 'get', 'method', 19, false, 'UserView'))
  check('nested class has container', is(f, 'Meta', 'class', 22, false, 'UserView'))
  check('definitions under if TYPE_CHECKING are module level', is(f, 'typed', 'function', 26, true))
  check('import', imported(f, 'os', [], 1))
  check('import as', imported(f, 'os.path', ['osp'], 2) && imported(f, 'sys', [], 2))
  check('from import with alias', imported(f, 'flask', ['Flask', 'req'], 3))
  check('relative from import', imported(f, '.', ['models'], 4))
  check('wildcard from import', imported(f, '..db', ['*'], 5))
  check('function-local import', imported(f, 'json', [], 15))
}

console.log('\n-- java: Spring --')
{
  const f = parse('java', 'src/main/java/com/shop/UserController.java', [
    'package com.shop.web;',                                   // 1
    '',                                                        // 2
    'import java.util.List;',                                  // 3
    'import org.springframework.web.bind.annotation.*;',       // 4
    '',                                                        // 5
    '@RestController',                                         // 6
    '@RequestMapping("/api/users")',                           // 7
    'public class UserController {',                           // 8
    '    private final UserRepository repo;',                  // 9
    '',                                                        // 10
    '    public UserController(UserRepository repo) {',        // 11
    '        this.repo = repo;',                               // 12
    '    }',                                                   // 13
    '',                                                        // 14
    '    @GetMapping("/{id}")',                                // 15
    '    public User get(@PathVariable Long id) {',            // 16
    '        return repo.findById(id).orElseThrow();',         // 17
    '    }',                                                   // 18
    '',                                                        // 19
    '    void helper() {}',                                    // 20
    '',                                                        // 21
    '    public enum Status { ACTIVE, LOCKED }',               // 22
    '}',                                                       // 23
    '',                                                        // 24
    'interface Auditable {',                                   // 25
    '    void audit();',                                       // 26
    '}',                                                       // 27
  ])
  check('parses cleanly', !f.parse_error)
  check('public class (line of the name, after annotations)', is(f, 'UserController', 'class', 8, true))
  check('constructor is a method', is(f, 'UserController', 'method', 11, true, 'UserController'))
  check('public annotated method', is(f, 'get', 'method', 16, true, 'UserController'))
  check('package-private method is not exported', is(f, 'helper', 'method', 20, false, 'UserController'))
  check('nested enum', is(f, 'Status', 'enum', 22, true, 'UserController'))
  check('package-private interface', is(f, 'Auditable', 'interface', 25, false))
  check('interface method is implicitly public', is(f, 'audit', 'method', 26, true, 'Auditable'))
  check('single-type import', imported(f, 'java.util.List', ['List'], 3))
  check('wildcard import', imported(f, 'org.springframework.web.bind.annotation', ['*'], 4))
}

console.log('\n-- go: net/http --')
{
  const f = parse('go', 'internal/handlers/users.go', [
    'package handlers',                                             // 1
    '',                                                             // 2
    'import "fmt"',                                                 // 3
    '',                                                             // 4
    'import (',                                                     // 5
    '\t"database/sql"',                                             // 6
    '\tweb "net/http"',                                             // 7
    '\t_ "github.com/lib/pq"',                                      // 8
    ')',                                                            // 9
    '',                                                             // 10
    'type UserStore struct {',                                      // 11
    '\tdb *sql.DB',                                                 // 12
    '}',                                                            // 13
    '',                                                             // 14
    'type Storer interface {',                                      // 15
    '\tGet(id int) (*User, error)',                                 // 16
    '}',                                                            // 17
    '',                                                             // 18
    'type handlerFunc func(w web.ResponseWriter, r *web.Request)',  // 19
    '',                                                             // 20
    'var Middleware = func(next web.Handler) web.Handler { return next }', // 21
    '',                                                             // 22
    'func (s *UserStore) Get(id int) (*User, error) {',             // 23
    '\treturn nil, nil',                                            // 24
    '}',                                                            // 25
    '',                                                             // 26
    'func (s UserStore) count() int { return 0 }',                  // 27
    '',                                                             // 28
    'func Login(w web.ResponseWriter, r *web.Request) {',           // 29
    '\tfmt.Fprintln(w, "ok")',                                      // 30
    '}',                                                            // 31
  ])
  check('parses cleanly', !f.parse_error)
  check('exported struct', is(f, 'UserStore', 'struct', 11, true))
  check('exported interface', is(f, 'Storer', 'interface', 15, true))
  check('interface method', is(f, 'Get', 'method', 16, true, 'Storer'))
  check('lower-case type is not exported', is(f, 'handlerFunc', 'type', 19, false))
  check('var bound to a func literal', is(f, 'Middleware', 'function', 21, true))
  check('pointer-receiver method: container is the type', is(f, 'Get', 'method', 23, true, 'UserStore'))
  check('lower-case method', is(f, 'count', 'method', 27, false, 'UserStore'))
  check('exported func', is(f, 'Login', 'function', 29, true))
  check('single import', imported(f, 'fmt', [], 3))
  check('grouped import', imported(f, 'database/sql', [], 6))
  check('aliased import', imported(f, 'net/http', ['web'], 7))
  check('blank import', imported(f, 'github.com/lib/pq', ['_'], 8))
}

console.log('\n-- ruby: Rails --')
{
  const f = parse('ruby', 'app/controllers/admin/users_controller.rb', [
    "require 'json'",                                          // 1
    "require_relative '../../lib/auth'",                       // 2
    '',                                                        // 3
    'module Admin',                                            // 4
    '  class UsersController < ApplicationController',         // 5
    '    before_action :authenticate_user!',                   // 6
    '',                                                        // 7
    '    def index',                                           // 8
    '      @users = User.where(params[:q])',                   // 9
    '    end',                                                 // 10
    '',                                                        // 11
    '    def self.build',                                      // 12
    '      new',                                               // 13
    '    end',                                                 // 14
    '',                                                        // 15
    '    private',                                             // 16
    '',                                                        // 17
    '    def user_params',                                     // 18
    '      params.require(:user).permit(:name)',               // 19
    '    end',                                                 // 20
    '  end',                                                   // 21
    'end',                                                     // 22
    '',                                                        // 23
    'def top_helper(x)',                                       // 24
    '  x',                                                     // 25
    'end',                                                     // 26
  ])
  check('parses cleanly', !f.parse_error)
  check('module', is(f, 'Admin', 'module', 4, true))
  check('class nested in module', is(f, 'UsersController', 'class', 5, true, 'Admin'))
  check('public method', is(f, 'index', 'method', 8, true, 'UsersController'))
  check('singleton method', is(f, 'build', 'method', 12, true, 'UsersController'))
  check('method after `private` is not exported', is(f, 'user_params', 'method', 18, false, 'UsersController'))
  check('top-level def is an exported function', is(f, 'top_helper', 'function', 24, true))
  check('require', imported(f, 'json', [], 1))
  check('require_relative', imported(f, '../../lib/auth', [], 2))
}

console.log('\n-- php: Laravel --')
{
  const f = parse('php', 'app/Http/Controllers/UserController.php', [
    '<?php',                                                     // 1
    'namespace App\\Http\\Controllers;',                          // 2
    '',                                                          // 3
    'use Illuminate\\Http\\Request;',                             // 4
    'use App\\Models\\{User, Post as Article};',                  // 5
    "require_once __DIR__ . '/../bootstrap.php';",               // 6
    "include 'config.php';",                                     // 7
    '',                                                          // 8
    'interface Searchable',                                      // 9
    '{',                                                         // 10
    '    public function search(string $q): array;',             // 11
    '}',                                                         // 12
    '',                                                          // 13
    'trait Loggable',                                            // 14
    '{',                                                         // 15
    '    protected function log($msg) {}',                       // 16
    '}',                                                         // 17
    '',                                                          // 18
    'class UserController extends Controller',                   // 19
    '{',                                                         // 20
    '    public function index(Request $request)',              // 21
    '    {',                                                     // 22
    "        return User::where('name', $request->input('name'))->get();", // 23
    '    }',                                                     // 24
    '',                                                          // 25
    '    private function secret() {}',                          // 26
    '',                                                          // 27
    '    function implicitPublic() {}',                          // 28
    '}',                                                         // 29
    '',                                                          // 30
    'function top_level_helper($x) { return $x; }',              // 31
  ])
  check('parses cleanly', !f.parse_error)
  check('interface', is(f, 'Searchable', 'interface', 9, true))
  check('interface method', is(f, 'search', 'method', 11, true, 'Searchable'))
  check('trait', is(f, 'Loggable', 'trait', 14, true))
  check('protected method is not exported', is(f, 'log', 'method', 16, false, 'Loggable'))
  check('class', is(f, 'UserController', 'class', 19, true))
  check('public method', is(f, 'index', 'method', 21, true, 'UserController'))
  check('private method', is(f, 'secret', 'method', 26, false, 'UserController'))
  check('method without modifier is public', is(f, 'implicitPublic', 'method', 28, true, 'UserController'))
  check('top-level function', is(f, 'top_level_helper', 'function', 31, true))
  check('use', imported(f, 'Illuminate\\Http\\Request', ['Request'], 4))
  check('group use with alias', imported(f, 'App\\Models\\User', ['User'], 5) && imported(f, 'App\\Models\\Post', ['Article'], 5))
  check('require_once of an expression, as written', imported(f, "__DIR__ . '/../bootstrap.php'", [], 6))
  check('include', imported(f, 'config.php', [], 7))
}

console.log('\n-- csharp: ASP.NET Core --')
{
  const f = parse('csharp', 'Controllers/OrdersController.cs', [
    'using System;',                                            // 1
    'using Microsoft.AspNetCore.Mvc;',                          // 2
    'using Json = Newtonsoft.Json;',                            // 3
    '',                                                         // 4
    'namespace Shop.Controllers;',                              // 5
    '',                                                         // 6
    '[ApiController]',                                          // 7
    '[Route("api/[controller]")]',                              // 8
    'public class OrdersController : ControllerBase',           // 9
    '{',                                                        // 10
    '    [HttpGet("{id}")]',                                    // 11
    '    public async Task<IActionResult> Get(int id)',         // 12
    '    {',                                                    // 13
    '        return Ok(await _db.Orders.FindAsync(id));',       // 14
    '    }',                                                    // 15
    '',                                                         // 16
    '    internal void Helper() {}',                            // 17
    '}',                                                        // 18
    '',                                                         // 19
    'public interface IOrderService',                           // 20
    '{',                                                        // 21
    '    void Place();',                                        // 22
    '}',                                                        // 23
    '',                                                         // 24
    'internal struct Money { }',                                // 25
    'public enum Status { Open, Closed }',                      // 26
    'public record OrderDto(int Id);',                          // 27
  ])
  check('parses cleanly (file-scoped namespace)', !f.parse_error)
  check('public class', is(f, 'OrdersController', 'class', 9, true))
  check('public method', is(f, 'Get', 'method', 12, true, 'OrdersController'))
  check('internal method is not exported', is(f, 'Helper', 'method', 17, false, 'OrdersController'))
  check('interface', is(f, 'IOrderService', 'interface', 20, true))
  check('interface member is implicitly public', is(f, 'Place', 'method', 22, true, 'IOrderService'))
  check('internal struct', is(f, 'Money', 'struct', 25, false))
  check('enum', is(f, 'Status', 'enum', 26, true))
  check('record', is(f, 'OrderDto', 'class', 27, true))
  check('using', imported(f, 'System', [], 1) && imported(f, 'Microsoft.AspNetCore.Mvc', [], 2))
  check('using alias', imported(f, 'Newtonsoft.Json', ['Json'], 3))
}

console.log('\n-- rust: actix --')
{
  const f = parse('rust', 'src/api.rs', [
    'use std::collections::HashMap;',                         // 1
    'use actix_web::{web, HttpResponse as Resp};',            // 2
    'use crate::db::*;',                                      // 3
    'mod handlers;',                                          // 4
    '',                                                       // 5
    'pub struct User {',                                      // 6
    '    pub id: i64,',                                       // 7
    '}',                                                      // 8
    '',                                                       // 9
    'pub trait Repo {',                                       // 10
    '    fn get(&self, id: i64) -> Option<User>;',            // 11
    '}',                                                      // 12
    '',                                                       // 13
    'impl User {',                                            // 14
    '    pub fn new(id: i64) -> Self { User { id } }',        // 15
    '    fn secret(&self) {}',                                // 16
    '}',                                                      // 17
    '',                                                       // 18
    'impl Repo for Db {',                                     // 19
    '    fn get(&self, id: i64) -> Option<User> { None }',    // 20
    '}',                                                      // 21
    '',                                                       // 22
    'pub async fn login(req: HttpRequest) -> impl Responder { Resp::Ok() }', // 23
    'fn helper() {}',                                         // 24
    'pub enum Role { Admin, Customer }',                      // 25
  ])
  check('parses cleanly', !f.parse_error)
  check('private module declaration', is(f, 'handlers', 'module', 4, false))
  check('pub struct', is(f, 'User', 'struct', 6, true))
  check('pub trait', is(f, 'Repo', 'trait', 10, true))
  check('trait item is as visible as the trait', is(f, 'get', 'method', 11, true, 'Repo'))
  check('pub method in impl', is(f, 'new', 'method', 15, true, 'User'))
  check('private method in impl', is(f, 'secret', 'method', 16, false, 'User'))
  check('trait impl method', is(f, 'get', 'method', 20, true, 'Db'))
  check('pub async fn', is(f, 'login', 'function', 23, true))
  check('private fn', is(f, 'helper', 'function', 24, false))
  check('pub enum', is(f, 'Role', 'enum', 25, true))
  check('use path', imported(f, 'std::collections::HashMap', ['HashMap'], 1))
  check('use list with alias', imported(f, 'actix_web', ['web', 'Resp'], 2))
  check('use wildcard', imported(f, 'crate::db', ['*'], 3))
}

console.log('\n-- c --')
{
  const f = parse('c', 'src/auth.c', [
    '#include <stdio.h>',                          // 1
    '#include "auth.h"',                           // 2
    '',                                            // 3
    'struct user { int id; };',                    // 4
    'typedef struct session { char *tok; } session_t;', // 5
    '',                                            // 6
    'static int helper(int x);',                   // 7
    '',                                            // 8
    'int check_password(const char *pw) {',        // 9
    '    char buf[16];',                           // 10
    '    strcpy(buf, pw);',                        // 11
    '    return helper(1);',                       // 12
    '}',                                           // 13
    '',                                            // 14
    'static int helper(int x) { return x; }',      // 15
    'char *get_name(struct user *u);',             // 16
    'int (*callback)(int);',                       // 17
  ])
  check('parses cleanly', !f.parse_error)
  check('struct', is(f, 'user', 'struct', 4, true))
  check('typedef struct: the struct...', is(f, 'session', 'struct', 5, true))
  check('...and the typedef name', is(f, 'session_t', 'type', 5, true))
  check('non-static function', is(f, 'check_password', 'function', 9, true))
  check('check_password spans its body', sym(f, 'check_password')?.end_line === 13)
  check('static function: prototype merged into the definition', is(f, 'helper', 'function', 15, false) &&
    f.symbols.filter((s) => s.name === 'helper').length === 1)
  check('prototype without definition is kept', is(f, 'get_name', 'function', 16, true))
  check('function pointer variable is not a function', absent(f, 'callback'))
  check('system include', imported(f, 'stdio.h', [], 1))
  check('local include', imported(f, 'auth.h', [], 2))
}

console.log('\n-- cpp --')
{
  const f = parse('cpp', 'src/session.cpp', [
    '#include <string>',                                   // 1
    '#include "db/conn.hpp"',                              // 2
    '',                                                    // 3
    'namespace app {',                                     // 4
    '',                                                    // 5
    'class Session {',                                     // 6
    'public:',                                             // 7
    '    bool valid() const;',                             // 8
    'private:',                                            // 9
    '    void rotate();',                                  // 10
    '};',                                                  // 11
    '',                                                    // 12
    'bool Session::valid() const { return true; }',        // 13
    '',                                                    // 14
    'static void hidden() {}',                             // 15
    '',                                                    // 16
    'int login(const std::string& user) { return 0; }',   // 17
    '',                                                    // 18
    '}  // namespace app',                                 // 19
    '',                                                    // 20
    'namespace {',                                         // 21
    'void internal_only() {}',                             // 22
    '}',                                                   // 23
  ])
  check('parses cleanly', !f.parse_error)
  check('class', is(f, 'Session', 'class', 6, true))
  check('out-of-class definition, access from the class body', is(f, 'valid', 'method', 13, true, 'Session') &&
    f.symbols.filter((s) => s.name === 'valid').length === 1)
  check('private member declaration', is(f, 'rotate', 'method', 10, false, 'Session'))
  check('static function', is(f, 'hidden', 'function', 15, false))
  check('namespaced function', is(f, 'login', 'function', 17, true))
  check('anonymous namespace is file-local', is(f, 'internal_only', 'function', 22, false))
  check('includes', imported(f, 'string', [], 1) && imported(f, 'db/conn.hpp', [], 2))
}

console.log('\n-- kotlin: Ktor/Spring --')
{
  const f = parse('kotlin', 'src/main/kotlin/com/shop/UserController.kt', [
    'package com.shop.api',                                  // 1
    '',                                                      // 2
    'import io.ktor.server.application.*',                   // 3
    'import io.ktor.server.routing.Route',                   // 4
    'import com.shop.db.UserRepo as Repo',                   // 5
    '',                                                      // 6
    '@RestController',                                       // 7
    'class UserController(private val repo: Repo) {',       // 8
    '    @GetMapping("/users/{id}")',                        // 9
    '    fun get(@PathVariable id: Long): User = repo.find(id)', // 10
    '',                                                      // 11
    '    private fun secret() {}',                           // 12
    '    internal fun moduleOnly() {}',                      // 13
    '',                                                      // 14
    '    companion object {',                                // 15
    '        fun create(): UserController = UserController(Repo())', // 16
    '    }',                                                 // 17
    '}',                                                     // 18
    '',                                                      // 19
    'interface Auditable {',                                 // 20
    '    fun audit()',                                       // 21
    '}',                                                     // 22
    '',                                                      // 23
    'enum class Role { ADMIN, USER }',                       // 24
    'private class Hidden',                                  // 25
    '',                                                      // 26
    'fun Route.userRoutes() {',                              // 27
    '    get("/users") { call.respondText("ok") }',         // 28
    '}',                                                     // 29
    '',                                                      // 30
    'val handler = { x: Int -> x }',                         // 31
  ])
  check('parses cleanly', !f.parse_error)
  check('class', is(f, 'UserController', 'class', 8, true))
  check('default-public method', is(f, 'get', 'method', 10, true, 'UserController'))
  check('private method', is(f, 'secret', 'method', 12, false, 'UserController'))
  check('internal method', is(f, 'moduleOnly', 'method', 13, false, 'UserController'))
  check('companion object method belongs to the class', is(f, 'create', 'method', 16, true, 'UserController'))
  check('interface', is(f, 'Auditable', 'interface', 20, true))
  check('interface method', is(f, 'audit', 'method', 21, true, 'Auditable'))
  check('enum class', is(f, 'Role', 'enum', 24, true))
  check('private class', is(f, 'Hidden', 'class', 25, false))
  check('extension function: name, not receiver', is(f, 'userRoutes', 'function', 27, true))
  check('top-level val bound to a lambda', is(f, 'handler', 'function', 31, true))
  check('wildcard import', imported(f, 'io.ktor.server.application', ['*'], 3))
  check('import', imported(f, 'io.ktor.server.routing.Route', ['Route'], 4))
  check('import alias', imported(f, 'com.shop.db.UserRepo', ['Repo'], 5))
}

console.log('\n-- swift: Vapor --')
{
  const f = parse('swift', 'Sources/App/Controllers/UserController.swift', [
    'import Foundation',                                         // 1
    'import Vapor',                                              // 2
    '',                                                          // 3
    'public struct UserController: RouteCollection {',          // 4
    '    public func boot(routes: RoutesBuilder) throws {',     // 5
    '        routes.get("users", use: index)',                  // 6
    '    }',                                                     // 7
    '',                                                          // 8
    '    func index(req: Request) async throws -> [User] {',   // 9
    '        return try await User.query(on: req.db).all()',    // 10
    '    }',                                                     // 11
    '}',                                                         // 12
    '',                                                          // 13
    'open class Base {',                                         // 14
    '    public init() {}',                                      // 15
    '}',                                                         // 16
    '',                                                          // 17
    'public protocol Repo {',                                    // 18
    '    func get(id: Int) -> User?',                            // 19
    '}',                                                         // 20
    '',                                                          // 21
    'extension User {',                                          // 22
    '    public func publicView() -> String { "" }',            // 23
    '}',                                                         // 24
    '',                                                          // 25
    'public func configure(_ app: Application) throws {}',      // 26
    'func helper() {}',                                          // 27
  ])
  check('parses cleanly', !f.parse_error)
  check('public struct', is(f, 'UserController', 'struct', 4, true))
  check('public method', is(f, 'boot', 'method', 5, true, 'UserController'))
  check('internal (default) method is not exported', is(f, 'index', 'method', 9, false, 'UserController'))
  check('open class', is(f, 'Base', 'class', 14, true))
  check('init', is(f, 'init', 'method', 15, true, 'Base'))
  check('public protocol', is(f, 'Repo', 'interface', 18, true))
  check('protocol requirement is as visible as the protocol', is(f, 'get', 'method', 19, true, 'Repo'))
  check('extension declares no type; members use the extended type', absent(f, 'User') &&
    is(f, 'publicView', 'method', 23, true, 'User'))
  check('public func', is(f, 'configure', 'function', 26, true))
  check('internal func', is(f, 'helper', 'function', 27, false))
  check('imports', imported(f, 'Foundation', [], 1) && imported(f, 'Vapor', [], 2))
}

console.log('\n-- coverage --')
{
  const grammars = new Set(Object.values(SYMBOL_GRAMMARS))
  check('13 inventory languages have a grammar (14 with tsx)', Object.keys(SYMBOL_GRAMMARS).length === 13 && grammars.size === 13)
  check('no grammar -> null', extractFileSymbols('{"a": 1}', 'json', 'package.json') === null)
}

console.log('\n-- bad input never throws --')
{
  let threw = false
  let f: FileSymbols | null = null
  try {
    f = extractFileSymbols(['def broken(:', '    pass', '', 'def ok():', '    return 1'].join('\n'), 'python', 'bad.py')
  } catch {
    threw = true
  }
  check('syntax error: no throw', !threw)
  check('syntax error: parse_error true', !!f && f.parse_error)
  check('syntax error: later definitions still recovered', !!f && !!sym(f, 'ok'))
  let threw2 = false
  try {
    for (const lang of Object.keys(SYMBOL_GRAMMARS)) extractFileSymbols('}}}{{{ ))) <<<\x00�', lang, `x.${lang}`)
  } catch {
    threw2 = true
  }
  check('garbage in every grammar: no throw', !threw2)
}

// ---------------------------------------------------------------------------
console.log('\n-- extractSymbolTable: benchmark guard and inventory flags --')
{
  const target = path.join(REPO_ROOT, 'target-apps/juice-shop-blind')
  const denied = SEED_DENYLIST.find((p) => p === 'target-apps/juice-shop-blind/lib/antiCheat.ts')!
  const deniedRel = path.relative(target, path.join(REPO_ROOT, denied)).split(path.sep).join('/')
  const entry = (p: string, extra: Partial<InventoryEntry> = {}): InventoryEntry =>
    ({ path: p, language: 'typescript', bytes: 1, test: false, oversize: false, empty: false, ...extra })
  const table = await extractSymbolTable(target, [
    entry(deniedRel),
    entry('test/server/thing.ts', { test: true }),
    entry('big.ts', { oversize: true }),
    entry('blank.ts', { empty: true }),
    entry('package.json', { language: 'json' }),
  ])
  check('denylisted lib/antiCheat.ts is skipped as guard_denied', table.skipped.guard_denied === 1)
  check('...and contributes no symbols', !(deniedRel in table.files))
  check('test entry skipped', table.skipped.test === 1)
  check('oversize entry skipped', table.skipped.oversize === 1)
  check('empty entry skipped', table.skipped.empty === 1)
  check('language without a grammar skipped', table.skipped.unsupported_language === 1)
  check('nothing parsed', Object.keys(table.files).length === 0 && Object.keys(table.languages).length === 0)
  check('parser versions recorded', table.parser.runtime === 'web-tree-sitter@0.25.10' && table.parser.grammars === 'tree-sitter-wasms@0.1.13')
}

console.log('\n-- extractSymbolTable: a product repo --')
{
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symbols-test-')))
  try {
    const files: Record<string, string> = {
      'app/main.py': 'from flask import Flask\napp = Flask(__name__)\n\n@app.get("/")\ndef index():\n    return "ok"\n',
      'app/broken.py': 'def broken(:\n    pass\n',
      'cmd/server/main.go': 'package main\n\nimport "net/http"\n\nfunc main() {\n\thttp.ListenAndServe(":8080", nil)\n}\n',
      'web/routes.js': "const express = require('express')\nmodule.exports = function routes (app) {}\n",
      'README.md': '# readme\n',
    }
    for (const [rel, src] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), src)
    }
    const ctx = resolveRunContext({ SCANNER_TARGET: root, SCANNER_RUNS_ROOT: path.join(root, '.secscan', 'runs') }, [], root)
    const guard = makeReadGuard(ctx)
    const entries: InventoryEntry[] = [
      { path: 'web/routes.js', language: 'javascript', bytes: 1, test: false, oversize: false, empty: false },
      { path: 'app/main.py', language: 'python', bytes: 1, test: false, oversize: false, empty: false },
      { path: 'cmd/server/main.go', language: 'go', bytes: 1, test: false, oversize: false, empty: false },
      { path: 'app/broken.py', language: 'python', bytes: 1, test: false, oversize: false, empty: false },
    ]
    const a = await extractSymbolTable(root, entries, guard)
    const b = await extractSymbolTable(root, [...entries].reverse(), guard)
    const strip = (t: typeof a) => JSON.stringify({ ...t, generated_at: '' })
    check('product guard allows the target', Object.keys(a.files).length === 4 && !a.skipped.guard_denied)
    check('files keyed in sorted order', JSON.stringify(Object.keys(a.files)) === JSON.stringify(Object.keys(a.files).sort()))
    check('languages counted', a.languages.python === 2 && a.languages.go === 1 && a.languages.javascript === 1)
    check('broken file: parse_error, no throw', a.files['app/broken.py']?.parse_error === true)
    check('good file: no parse_error', a.files['app/main.py']?.parse_error === false)
    check('flask view', exportedNames(a.files['app/main.py']).has('index'))
    check('go main', a.files['cmd/server/main.go']?.symbols.some((s) => s.name === 'main' && !s.exported))
    check('module.exports = function name', exportedNames(a.files['web/routes.js']).has('routes'))
    check('deterministic regardless of entry order', strip(a) === strip(b))
    check('target_dir recorded', a.target_dir === root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
