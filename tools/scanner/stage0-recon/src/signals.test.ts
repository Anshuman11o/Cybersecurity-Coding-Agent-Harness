/** Tests for per-file signals (signal-detector.ts, shared/signal-classes.json). Run: npx tsx src/signals.test.ts */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectAllSignalsFromList,
  detectSinkSignals,
  SINK_PATTERN_LANGUAGES,
  type Signal,
} from './signal-detector.js'
import { initSymbolParsers, extractFileSymbols } from './symbols.js'
import { EXTENSION_LANGUAGES, type FileSymbols, type SymbolTableArtifact } from './recon-contract.js'
import { SOLIDITY_ARITHMETIC, solidityStructuralSignals } from './solidity-signals.js'

let pass = 0, fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

const FIXTURE_LANGUAGES = ['python', 'java', 'go', 'ruby', 'php', 'csharp']
const CONTENT_SIGNALS: Signal[] = [
  'route_handler', 'db_query', 'model_schema', 'model_write', 'http_outbound', 'auth_check',
  'crypto_op', 'html_sink', 'dynamic_exec', 'deserialize', 'file_io', 'llm_call', 'logging',
]

// ---------------------------------------------------------------------------
console.log('\n-- signal-classes.json: sink_patterns --')
const classesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../shared/signal-classes.json')
const classes = JSON.parse(fs.readFileSync(classesPath, 'utf-8'))
{
  check('floor and signals still present', Array.isArray(classes.floor) && Object.keys(classes.signals).length === 15)
  check('every sink_patterns key is a language produced by EXTENSION_LANGUAGES, and every key defines every content signal',
    Object.entries<Record<string, string[]>>(classes.sink_patterns).every(([language, signals]) =>
      Object.values(EXTENSION_LANGUAGES).includes(language) && CONTENT_SIGNALS.every(signal => Array.isArray(signals[signal]))))
  check('detector serves every registered language', JSON.stringify([...SINK_PATTERN_LANGUAGES].sort()) === JSON.stringify(Object.keys(classes.sink_patterns).sort()))
  let total = 0, bad: string[] = [], unknown: string[] = []
  for (const [lang, sigs] of Object.entries<Record<string, string[]>>(classes.sink_patterns)) {
    for (const [sig, pats] of Object.entries(sigs)) {
      if (!(sig in classes.signals) || !CONTENT_SIGNALS.includes(sig as Signal)) unknown.push(`${lang}.${sig}`)
      for (const p of pats) {
        total++
        try { new RegExp(p, 'm') } catch { bad.push(`${lang}.${sig}: ${p}`) }
      }
    }
  }
  check(`every sink pattern compiles with flag m (${total} patterns)`, total > 0 && bad.length === 0)
  for (const b of bad) console.log(`        does not compile: ${b}`)
  check('only existing content signal names', unknown.length === 0)
  for (const lang of Object.keys(classes.sink_patterns)) {
    const missing = CONTENT_SIGNALS.filter((s) => !(classes.sink_patterns[lang][s]?.length > 0))
    check(`${lang}: patterns for all 13 content signals`, missing.length === 0)
  }
}

// ---------------------------------------------------------------------------
// Positive and negative fixtures, per language and signal. A positive must
// raise the signal; a negative is a near miss that must not.

type Cases = Record<string, { pos: string[]; neg: string[] }>

const FIXTURES: Record<string, Cases> = {
  python: {
    route_handler: {
      pos: [
        '@app.route("/login", methods=["POST"])\ndef login():\n    return "ok"',
        '@router.get("/items/{item_id}")\nasync def read_item(item_id: int):\n    return {}',
        'urlpatterns = [\n    path("users/<int:pk>/", views.user_detail),\n]',
        'class UserViewSet(viewsets.ModelViewSet):\n    queryset = User.objects.all()',
      ],
      neg: ['def helper(request):\n    return None', 'full = os.path.join(base, "static")', '@property\ndef name(self):\n    return self._name'],
    },
    db_query: {
      pos: [
        'cursor.execute("SELECT * FROM users WHERE id = %s" % user_id)',
        'db.session.execute(text(f"SELECT * FROM users WHERE name = \'{name}\'"))',
        'User.objects.raw("SELECT * FROM auth_user WHERE username = \'%s\'" % u)',
        'users = User.objects.filter(email=email)',
        'doc = db.users.find_one({"name": name})',
      ],
      neg: ['idx = name.find("@")', 'future = executor.submit(work)', 'print("select something from the menu")'],
    },
    model_schema: {
      pos: [
        'class User(models.Model):\n    email = models.EmailField(unique=True)',
        'class Account(Base):\n    __tablename__ = "accounts"\n    id = Column(Integer, primary_key=True)',
        'class Item(BaseModel):\n    name: str',
      ],
      neg: ['class Config:\n    DEBUG = True', 'class Handler(object):\n    pass'],
    },
    model_write: {
      pos: ['user.save()', 'User.objects.create(**request.data)', 'db.session.add(user)', 'for k, v in data.items():\n    setattr(user, k, v)'],
      neg: ['settings = {}\nsettings.update({"a": 1})', 'seen = set()\nseen.add(x)'],
    },
    http_outbound: {
      pos: ['resp = requests.get(url, timeout=5)', 'async with httpx.AsyncClient() as client:\n    r = await client.get(url)', 'data = urllib.request.urlopen(target).read()'],
      neg: ['requests_count = 0', 'return render(request, "index.html")'],
    },
    auth_check: {
      pos: [
        '@login_required\ndef profile(request):\n    pass',
        'async def me(user: User = Depends(get_current_user)):\n    return user',
        'if not request.user.is_authenticated:\n    raise PermissionDenied',
        'token = jwt.decode(raw, SECRET, algorithms=["HS256"])',
      ],
      neg: ['def add(a, b):\n    return a + b', 'deps = Depends(get_db)'],
    },
    crypto_op: {
      pos: [
        'digest = hashlib.md5(password.encode()).hexdigest()',
        'hashed = bcrypt.hashpw(pw, bcrypt.gensalt())',
        'from cryptography.fernet import Fernet',
        'token = secrets.token_urlsafe(32)',
        'ct = cipher.encrypt(data)',
      ],
      neg: ['import random\nroll = random.randint(1, 6)', 'encrypted_document = open("out.md", "w")'],
    },
    html_sink: {
      pos: [
        'return mark_safe(f"<b>{name}</b>")',
        'return render_template_string("<h1>" + title + "</h1>")',
        'html = Markup(user_bio)',
        'env = Environment(loader=loader, autoescape=False)',
      ],
      neg: ['return render_template("index.html", name=name)', 'safe_name = escape(name)'],
    },
    dynamic_exec: {
      pos: ['result = eval(expr)', 'subprocess.run(cmd, shell=True)', 'os.system("ping " + host)', 'mod = importlib.import_module(name)'],
      neg: ['pattern = re.compile(r"\\d+")', 'model.eval()', 'value = ast.literal_eval(s)'],
    },
    deserialize: {
      pos: ['obj = pickle.loads(request.data)', 'cfg = yaml.load(stream, Loader=yaml.Loader)', 'payload = json.loads(body)', 'tree = ET.fromstring(xml_text)'],
      neg: ['out = pickle.dumps(obj)', 'text = yaml.safe_dump(cfg)', 's = json.dumps(obj)'],
    },
    file_io: {
      pos: [
        'with open(path, "rb") as fh:\n    data = fh.read()',
        'return send_file(os.path.join(UPLOAD_DIR, filename))',
        'shutil.rmtree(tmp)',
        'zf.extractall(dest)',
      ],
      neg: ['webbrowser.open(url)', 'is_open = door.opened'],
    },
    llm_call: {
      pos: [
        'from openai import OpenAI\nclient = OpenAI()',
        'resp = client.chat.completions.create(model=m, messages=msgs)',
        'llm = ChatAnthropic(model="x").bind_tools([search])',
        'msg = client.messages.create(model=m, max_tokens=100, messages=msgs)',
      ],
      neg: ['from openapi_spec_validator import validate', 'response = session.post(url, json=payload)'],
    },
    logging: {
      pos: ['logger.error("login failed for %s", user)', 'logging.warning("disk low")', 'app.logger.exception("boom")'],
      neg: ['logger.info("ok")', 'log.debug("x")'],
    },
  },

  java: {
    route_handler: {
      pos: [
        '@GetMapping("/users/{id}")\npublic User get(@PathVariable Long id) { return null; }',
        '@Path("/orders")\npublic class OrderResource {}',
        'public class LoginServlet extends HttpServlet {\n  protected void doPost(HttpServletRequest req, HttpServletResponse resp) {}\n}',
        'app.get("/hello", ctx -> ctx.result("hi"));',
      ],
      neg: ['public class UserService {\n  public User find(Long id) { return repo.findById(id).get(); }\n}', 'String v = map.get("key");'],
    },
    db_query: {
      pos: [
        'Statement st = conn.createStatement();\nResultSet rs = st.executeQuery("SELECT * FROM users WHERE name = \'" + name + "\'");',
        'PreparedStatement ps = conn.prepareStatement(sql);',
        '@Query("select u from User u where u.email = ?1")\nUser findByEmail(String email);',
        'List<User> l = em.createQuery("FROM User WHERE name = \'" + n + "\'").getResultList();',
      ],
      neg: ['List<String> names = list.stream().map(String::trim).toList();', 'String s = "selected from the list";'],
    },
    model_schema: {
      pos: ['@Entity\n@Table(name = "users")\npublic class User {\n  @Id @GeneratedValue private Long id;\n}', 'public class UserDto {\n  @JsonIgnore private String password;\n}'],
      neg: ['public class Point {\n  private int x;\n}'],
    },
    model_write: {
      pos: ['userRepository.save(user);', 'entityManager.persist(order);', 'BeanUtils.copyProperties(request, user);'],
      neg: ['md.update(bytes);', 'file.delete();'],
    },
    http_outbound: {
      pos: [
        'HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();',
        'String body = restTemplate.getForObject(url, String.class);',
        'HttpClient client = HttpClient.newHttpClient();',
        'Document d = Jsoup.connect(url).get();',
      ],
      neg: ['String url = request.getRequestURI();', 'URL_PATTERN.matcher(s).matches();'],
    },
    auth_check: {
      pos: [
        '@PreAuthorize("hasRole(\'ADMIN\')")\npublic void delete(Long id) {}',
        'Authentication a = SecurityContextHolder.getContext().getAuthentication();',
        'http.authorizeHttpRequests(a -> a.requestMatchers("/admin/**").hasRole("ADMIN"));',
        'HttpSession s = request.getSession();',
      ],
      neg: ['public int add(int a, int b) { return a + b; }'],
    },
    crypto_op: {
      pos: [
        'MessageDigest md = MessageDigest.getInstance("MD5");',
        'Cipher c = Cipher.getInstance("AES/ECB/PKCS5Padding");',
        'String h = BCrypt.hashpw(pw, BCrypt.gensalt());',
        'SecretKeySpec k = new SecretKeySpec(key, "HmacSHA256");',
      ],
      neg: ['Random r = new Random();\nint n = r.nextInt(6);', 'String hashCode = String.valueOf(obj.hashCode());'],
    },
    html_sink: {
      pos: [
        'response.getWriter().println("<p>" + name + "</p>");',
        '@GetMapping(value = "/page", produces = MediaType.TEXT_HTML_VALUE)',
        'String tpl = "<p th:utext=\\"${bio}\\"></p>";',
        'response.setContentType("text/html");',
      ],
      neg: ['return ResponseEntity.ok(json);', 'response.setContentType("application/json");'],
    },
    dynamic_exec: {
      pos: [
        'Process p = Runtime.getRuntime().exec(cmd);',
        'new ProcessBuilder("sh", "-c", cmd).start();',
        'Object v = new SpelExpressionParser().parseExpression(expr).getValue();',
        'Class<?> c = Class.forName(className);',
        'Object r = engine.eval(script);',
      ],
      neg: ['executor.execute(task);', 'String s = runtime.toString();'],
    },
    deserialize: {
      pos: [
        'ObjectInputStream in = new ObjectInputStream(req.getInputStream());\nObject o = in.readObject();',
        'User u = mapper.readValue(body, User.class);',
        'Object o = new Yaml().load(input);',
        'DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();',
      ],
      neg: ['String json = mapper.writeValueAsString(user);', 'out.writeObject(obj);'],
    },
    file_io: {
      pos: [
        'File f = new File(uploadDir, filename);',
        'byte[] b = Files.readAllBytes(Paths.get(base, name));',
        'file.transferTo(dest);',
        'InputStream is = getClass().getResourceAsStream(path);',
      ],
      neg: ['String profile = user.getProfile();', 'String fileName = "report";'],
    },
    llm_call: {
      pos: [
        'import dev.langchain4j.model.openai.OpenAiChatModel;',
        'ChatLanguageModel model = OpenAiChatModel.builder().apiKey(key).build();',
        'ChatClient chatClient = builder.build();',
        '@Tool("Look up an order")\npublic Order lookup(String id) { return null; }',
      ],
      neg: ['import java.util.concurrent.Callable;', 'String tool = "hammer";'],
    },
    logging: {
      pos: ['log.error("Login failed for {}", user);', 'private static final Logger LOG = LoggerFactory.getLogger(UserService.class);', 'e.printStackTrace();'],
      neg: ['log.info("started");', 'logger.debug("x");'],
    },
  },

  go: {
    route_handler: {
      pos: [
        'http.HandleFunc("/login", loginHandler)',
        'r.GET("/users/:id", getUser)',
        'func Login(w http.ResponseWriter, r *http.Request) {\n}',
        'func GetUser(c *gin.Context) {\n}',
      ],
      neg: ['token := r.Header.Get("Authorization")', 'v := cache.Get("key")'],
    },
    db_query: {
      pos: [
        'rows, err := db.Query("SELECT * FROM users WHERE name = \'" + name + "\'")',
        'db.Raw(fmt.Sprintf("SELECT * FROM users WHERE id = %s", id)).Scan(&u)',
        'err := db.QueryRow("SELECT id FROM users WHERE email = $1", email).Scan(&id)',
        'db.First(&user, id)',
      ],
      neg: ['err := tmpl.Execute(w, data)', 'n := strings.Count(s, "a")'],
    },
    model_schema: {
      pos: [
        'type User struct {\n\tID    uint   `gorm:"primaryKey"`\n\tEmail string `gorm:"uniqueIndex"`\n}',
        'type Order struct {\n\tgorm.Model\n\tTotal int\n}',
        'db.AutoMigrate(&User{})',
      ],
      neg: ['type Config struct {\n\tPort int `json:"port"`\n}'],
    },
    model_write: {
      pos: ['db.Create(&user)', 'db.Save(&order)', '_, err := coll.InsertOne(ctx, doc)'],
      neg: ['f, err := os.Create(path)', 'm := make(map[string]int)'],
    },
    http_outbound: {
      pos: ['resp, err := http.Get(target)', 'req, _ := http.NewRequest("GET", u, nil)\nresp, err := client.Do(req)', 'proxy := httputil.NewSingleHostReverseProxy(remote)'],
      neg: ['u := r.URL.Query().Get("url")', 'client := NewClient()'],
    },
    auth_check: {
      pos: [
        'token, err := jwt.Parse(raw, keyFunc)',
        'auth := r.Header.Get("Authorization")',
        'user, pass, ok := r.BasicAuth()',
        'if err := bcrypt.CompareHashAndPassword(hash, []byte(pw)); err != nil {\n}',
        'router.Use(AuthMiddleware())',
      ],
      neg: ['sum := add(a, b)', 'author := book.Author'],
    },
    crypto_op: {
      pos: ['import "crypto/md5"', 'sum := sha256.Sum256(data)', 'block, _ := aes.NewCipher(key)', 'cfg := &tls.Config{InsecureSkipVerify: true}'],
      neg: ['n := rand.Intn(10)', 'h := hash(key)'],
    },
    html_sink: {
      pos: ['out := template.HTML(userInput)', 'import "text/template"', 'fmt.Fprintf(w, "<h1>%s</h1>", name)', 'c.HTML(http.StatusOK, "<b>"+msg+"</b>")'],
      neg: ['import "html/template"', 'fmt.Printf("%s\\n", name)'],
    },
    dynamic_exec: {
      pos: ['out, err := exec.Command("sh", "-c", cmd).Output()', 'p, err := plugin.Open(path)', 'm := reflect.ValueOf(obj).MethodByName(name)'],
      neg: ['res, err := db.Exec("DELETE FROM t")', 'cmd := flag.String("cmd", "", "")'],
    },
    deserialize: {
      pos: ['dec := gob.NewDecoder(conn)', 'err := json.Unmarshal(body, &req)', 'if err := c.ShouldBindJSON(&input); err != nil {\n}', 'err := yaml.Unmarshal(data, &cfg)'],
      neg: ['b, _ := json.Marshal(v)', 'enc := gob.NewEncoder(w)'],
    },
    file_io: {
      pos: ['data, err := os.ReadFile(filepath.Join(base, name))', 'http.ServeFile(w, r, path)', 'file, _ := c.FormFile("upload")', 'f, _ := os.Create(dst)'],
      neg: ['name := strings.TrimSpace(input)', 'p := path.Base(u)'],
    },
    llm_call: {
      pos: ['import openai "github.com/sashabaranov/go-openai"', 'resp, err := client.CreateChatCompletion(ctx, req)', 'msg, err := client.Messages.New(ctx, params)'],
      neg: ['import "github.com/spf13/cobra"', 'resp, err := client.Do(req)'],
    },
    logging: {
      pos: ['log.Printf("login failed: %v", err)', 'logger.Error("db down", zap.Error(err))', 'import "go.uber.org/zap"'],
      neg: ['fmt.Println("hello")', 'logger.Info("ok")'],
    },
  },

  ruby: {
    route_handler: {
      pos: [
        "Rails.application.routes.draw do\n  resources :users\n  get 'login', to: 'sessions#new'\nend",
        'class UsersController < ApplicationController\n  def show; end\nend',
        "get '/hello' do\n  'hi'\nend",
        'class API < Grape::API\nend',
      ],
      neg: ['class User < ApplicationRecord\nend', 'value = hash.get(:key)'],
    },
    db_query: {
      pos: [
        'User.where("name = \'#{params[:name]}\'")',
        'ActiveRecord::Base.connection.execute("DELETE FROM users WHERE id = #{id}")',
        'users = User.find_by_sql(sql)',
        '@post = Post.find(params[:id])',
      ],
      neg: ['names = list.map(&:upcase)', 'x = items.first'],
    },
    model_schema: {
      pos: [
        'class User < ApplicationRecord\n  has_many :posts\n  validates :email, presence: true\nend',
        'class Doc\n  include Mongoid::Document\n  field :title\nend',
        'create_table :users do |t|\n  t.string :email\nend',
      ],
      neg: ['class Helper\n  def call; end\nend'],
    },
    model_write: {
      pos: ['@user.update(user_params)', 'user.save!', 'User.create!(params[:user])', 'params.require(:user).permit!'],
      neg: ['stamp = record.updated_at', 'list = items.select { |i| i.ok? }'],
    },
    http_outbound: {
      pos: ['res = Net::HTTP.get_response(URI.parse(url))', 'resp = HTTParty.get(url)', 'conn = Faraday.new(url: base)'],
      neg: ['url = request.original_url', 'uri = "http://example.com"'],
    },
    auth_check: {
      pos: [
        'before_action :authenticate_user!',
        'authorize @post',
        'if current_user.admin?\nend',
        'session[:user_id] = user.id',
        'skip_before_action :verify_authenticity_token',
      ],
      neg: ['def add(a, b)\n  a + b\nend', 'author = post.author'],
    },
    crypto_op: {
      pos: ['digest = Digest::MD5.hexdigest(password)', "cipher = OpenSSL::Cipher.new('aes-256-cbc')", 'token = SecureRandom.hex(32)', 'hashed = BCrypt::Password.create(pw)'],
      neg: ['n = rand(6)', 'name.reverse'],
    },
    html_sink: {
      pos: ['"<b>#{name}</b>".html_safe', 'raw(@comment.body)', 'render inline: params[:template]', 'ERB.new(template).result(binding)'],
      neg: ['h(@comment.body)', 'rawdata = fetch'],
    },
    dynamic_exec: {
      pos: ['eval(params[:code])', 'system("convert #{file} out.png")', 'output = `ls #{dir}`', 'obj.send(params[:method])', 'klass = params[:type].constantize'],
      neg: ['evaluation = score * 2', 'sender.notify(x)', 'systems = []'],
    },
    deserialize: {
      pos: ['obj = Marshal.load(Base64.decode64(cookie))', 'cfg = YAML.load(params[:yaml])', 'data = JSON.parse(request.body.read)', 'doc = Nokogiri::XML(xml)'],
      neg: ['str = Marshal.dump(obj)', 'out = data.to_json'],
    },
    file_io: {
      pos: ["File.read(Rails.root.join('public', params[:file]))", 'send_file params[:path]', 'FileUtils.rm_rf(dir)', 'files = Dir.glob("uploads/*")'],
      neg: ['profile = user.profile', 'filename = "a.txt"'],
    },
    llm_call: {
      pos: ['client = OpenAI::Client.new(access_token: key)', "require 'ruby_llm'", 'response = client.chat(parameters: { model: m, messages: msgs })'],
      neg: ["require 'json'", 'client = Redis.new'],
    },
    logging: {
      pos: ['Rails.logger.error("payment failed: #{e.message}")', 'logger.warn "slow query"', 'Rails.application.config.filter_parameters += [:password]'],
      neg: ['logger.info "ok"', 'puts "done"'],
    },
  },

  php: {
    route_handler: {
      pos: [
        "Route::get('/users/{id}', [UserController::class, 'show']);",
        "#[Route('/blog/{slug}', name: 'blog_show')]\npublic function show(string $slug) {}",
        "$app->get('/hello/{name}', function ($request, $response) {});",
        "$id = $_GET['id'];",
        'class UserController extends Controller {}',
      ],
      neg: ["$value = $config->get('app.name');", 'function helper($x) { return $x; }'],
    },
    db_query: {
      pos: [
        "$result = mysqli_query($conn, \"SELECT * FROM users WHERE id = \" . $_GET['id']);",
        "$stmt = $pdo->query(\"SELECT * FROM users WHERE name = '$name'\");",
        '$users = DB::select("select * from users where active = ?", [1]);',
        "$q = User::whereRaw(\"name = '\" . $n . \"'\")->get();",
        '$user = User::find($id);',
      ],
      neg: ['$len = strlen($s);', '$x = array_filter($items);'],
    },
    model_schema: {
      pos: [
        "class User extends Model\n{\n    protected $fillable = ['name', 'email'];\n}",
        '#[ORM\\Entity]\nclass Product {}',
        "Schema::create('users', function (Blueprint $table) {\n    $table->id();\n});",
      ],
      neg: ['class Helper {\n    private $cache = [];\n}'],
    },
    model_write: {
      pos: ['$user->update($request->all());', '$post->save();', 'User::create($request->all());', '$em->persist($product);\n$em->flush();'],
      neg: ['$total = $a + $b;', '$items[] = $x;'],
    },
    http_outbound: {
      pos: ['$ch = curl_init($url);\ncurl_exec($ch);', "$body = file_get_contents($_GET['url']);", '$resp = Http::get($endpoint);', '$client = new \\GuzzleHttp\\Client();'],
      neg: ["$html = file_get_contents('templates/header.html');", "$url = route('home');"],
    },
    auth_check: {
      pos: [
        'if (Auth::check()) {}',
        "Route::get('/admin', fn () => 1)->middleware('auth');",
        "$this->authorize('update', $post);",
        'if (password_verify($pw, $hash)) {}',
        "$_SESSION['user'] = $user;",
      ],
      neg: ['$author = $book->author;', 'function sum($a, $b) { return $a + $b; }'],
    },
    crypto_op: {
      pos: ['$hash = md5($password);', '$h = password_hash($pw, PASSWORD_DEFAULT);', "$enc = openssl_encrypt($data, 'aes-256-cbc', $key, 0, $iv);", '$token = bin2hex(random_bytes(16));'],
      neg: ['$n = mt_rand(1, 6);', '$s = $obj->hash;'],
    },
    html_sink: {
      pos: ["echo \"Hello \" . $_GET['name'];", '<?= $title ?>', '{!! $comment->body !!}', '{{ user.bio|raw }}'],
      neg: ['echo "Hello world";', '{{ $comment->body }}'],
    },
    dynamic_exec: {
      pos: ['eval($code);', '$out = shell_exec("ping " . $host);', 'system($cmd);', "include $_GET['page'] . '.php';", 'call_user_func($callback, $arg);'],
      neg: ['$this->system->boot();', "include 'header.php';"],
    },
    deserialize: {
      pos: ["$obj = unserialize($_COOKIE['data']);", '$data = json_decode($body, true);', '$xml = simplexml_load_string($input);', '$doc = new DOMDocument();\n$doc->loadXML($xml);'],
      neg: ['$s = serialize($obj);', '$j = json_encode($data);'],
    },
    file_io: {
      pos: ['$content = file_get_contents($path);', "move_uploaded_file($_FILES['f']['tmp_name'], $dest);", 'unlink($file);', 'Storage::put($name, $contents);'],
      neg: ['$profile = $user->profile();', '$f = $form->file;'],
    },
    llm_call: {
      pos: ['$client = OpenAI::client($apiKey);', "$result = $client->chat()->create(['model' => 'gpt-4o', 'messages' => $m]);", "$r = Prism::text()->using('anthropic', 'claude')->generate();"],
      neg: ['$client = new Redis();', '$chat = $room->chat;'],
    },
    logging: {
      pos: ["Log::error('Payment failed', ['id' => $id]);", 'error_log("login failed for $user");', "$this->logger->warning('slow');"],
      neg: ["Log::info('ok');", 'echo "done";'],
    },
  },

  csharp: {
    route_handler: {
      pos: [
        '[HttpGet("{id}")]\npublic IActionResult Get(int id) => Ok();',
        'public class OrdersController : ControllerBase {}',
        'app.MapGet("/todos/{id}", (int id) => id);',
        'public async Task<IActionResult> OnPostAsync() { return Page(); }',
      ],
      neg: ['public class OrderService {}', 'var x = dict["key"];'],
    },
    db_query: {
      pos: [
        'var cmd = new SqlCommand("SELECT * FROM Users WHERE Name = \'" + name + "\'", conn);',
        'var r = cmd.ExecuteReader();',
        'var users = _db.Users.FromSqlRaw("SELECT * FROM Users WHERE Name = \'" + n + "\'").ToList();',
        'var u = await _context.Users.FirstOrDefaultAsync(x => x.Id == id);',
        'var rows = conn.Query<User>(sql);',
      ],
      neg: ['var names = list.Select(x => x.Trim()).ToList();', 'var s = "selection";'],
    },
    model_schema: {
      pos: ['public DbSet<User> Users { get; set; }', '[Table("Orders")]\npublic class Order { [Key] public int Id { get; set; } }', 'public class AppDbContext : DbContext {}'],
      neg: ['public class Point { public int X { get; set; } }'],
    },
    model_write: {
      pos: ['_db.Users.Add(user);\n_db.SaveChanges();', 'await _context.SaveChangesAsync();', 'await TryUpdateModelAsync(user);'],
      neg: ['list.Add(item);', 'sb.Append(x);'],
    },
    http_outbound: {
      pos: ['using var client = new HttpClient();', 'var r = await client.GetAsync(url);', 'var req = WebRequest.Create(url);', 'var c = _factory.CreateClient("api");'],
      neg: ['var url = Request.Path;', 'var c = new Customer();'],
    },
    auth_check: {
      pos: [
        '[Authorize(Roles = "Admin")]\npublic IActionResult Delete(int id) => Ok();',
        'var id = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;',
        'app.UseAuthentication();\napp.UseAuthorization();',
        'var result = await _signInManager.PasswordSignInAsync(u, p, false, false);',
      ],
      neg: ['public int Add(int a, int b) => a + b;', 'var author = book.Author;'],
    },
    crypto_op: {
      pos: ['using System.Security.Cryptography;', 'using var md5 = MD5.Create();', 'var kdf = new Rfc2898DeriveBytes(pw, salt, 1000);', 'var hash = BCrypt.Net.BCrypt.HashPassword(pw);'],
      neg: ['var r = new Random();\nvar n = r.Next(6);', 'var h = obj.GetHashCode();'],
    },
    html_sink: {
      pos: ['@Html.Raw(Model.Bio)', 'return new HtmlString(userInput);', 'Response.Write("<p>" + name + "</p>");', 'return Content(html, "text/html");'],
      neg: ['@Html.DisplayFor(m => m.Bio)', 'return Json(model);'],
    },
    dynamic_exec: {
      pos: [
        'Process.Start("cmd.exe", "/c " + input);',
        'var psi = new ProcessStartInfo { FileName = "sh", Arguments = cmd };',
        'var asm = Assembly.LoadFrom(path);',
        'var obj = Activator.CreateInstance(Type.GetType(typeName));',
      ],
      neg: ['var p = new Person();', 'processor.Run();'],
    },
    deserialize: {
      pos: [
        'var obj = new BinaryFormatter().Deserialize(stream);',
        'var s = new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.All };',
        'var u = JsonConvert.DeserializeObject<User>(body);',
        'var doc = new XmlDocument();\ndoc.LoadXml(xml);',
      ],
      neg: ['var json = JsonConvert.SerializeObject(user);', 'var s = JsonSerializer.Serialize(obj);'],
    },
    file_io: {
      pos: [
        'var text = File.ReadAllText(Path.Combine(root, name));',
        'using var fs = new FileStream(path, FileMode.Open);',
        'public async Task Upload(IFormFile file) { await file.CopyToAsync(stream); }',
        'return PhysicalFile(path, "application/pdf");',
      ],
      neg: ['var profile = user.Profile;', 'var name = "file.txt";'],
    },
    llm_call: {
      pos: ['using OpenAI.Chat;', 'var client = new AzureOpenAIClient(endpoint, cred);', 'var builder = Kernel.CreateBuilder();', 'var reply = await chat.CompleteChatAsync(messages);'],
      neg: ['using System.Text.Json;', 'var chat = new ChatRoom();'],
    },
    logging: {
      pos: ['_logger.LogError(ex, "Payment failed for {Id}", id);', 'Log.Warning("slow request");', 'private readonly ILogger<OrdersController> _logger;'],
      neg: ['_logger.LogInformation("ok");', 'Console.WriteLine("done");'],
    },
  },
}

for (const lang of FIXTURE_LANGUAGES) {
  console.log(`\n-- ${lang}: positive and negative fixtures --`)
  const cases = FIXTURES[lang]
  check(`${lang}: fixtures for all 13 content signals`, CONTENT_SIGNALS.every((s) => (cases[s]?.pos.length ?? 0) > 0 && (cases[s]?.neg.length ?? 0) > 0))
  for (const signal of CONTENT_SIGNALS) {
    const c = cases[signal]
    if (!c) continue
    c.pos.forEach((src, i) => check(`${lang} ${signal} +${i + 1}`, detectSinkSignals(lang, src).includes(signal)))
    c.neg.forEach((src, i) => check(`${lang} ${signal} -${i + 1}`, !detectSinkSignals(lang, src).includes(signal)))
  }
}

console.log('\n-- sink patterns stay linear on 1 MB inputs (the byte cap) --')
{
  // An unanchored leading \w+ or \s+ is quadratic on a long run of word
  // characters or whitespace; these shapes caught two such patterns. Each is
  // timed at 64 KB first (a quadratic pattern takes seconds there, a linear one
  // milliseconds) so a regression fails instead of hanging at 1 MB.
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
  const shapes: Record<string, (n: number) => string> = {
    'code': (n) => fill('x = "SELECT a, b, c, d, e, f, g, h, i, j, k" + foo.bar(baz, qux) + `ls ${d}` # \'"\\ <%= <?= {!! \n', n),
    'one long word': (n) => fill('a', n),
    'whitespace run': (n) => fill(' ', n),
    'repeated SQL keyword': (n) => fill('SELECT ', n),
    'dotted words': (n) => fill('a.b ', n),
    'one long argument list': (n) => 'class X(' + fill('a,', n),
  }
  const time = (lang: string, input: string) => {
    const t0 = performance.now()
    detectSinkSignals(lang, input)
    return performance.now() - t0
  }
  for (const lang of Object.keys(classes.sink_patterns)) {
    const slow = Object.entries(shapes).filter(([, make]) => time(lang, make(64_000)) > 500).map(([s]) => s)
    check(`${lang}: linear on every shape at 64 KB${slow.length ? ` (slow: ${slow.join(', ')})` : ''}`, slow.length === 0)
    if (slow.length) continue
    let worst = 0, worstShape = ''
    for (const [shape, make] of Object.entries(shapes)) {
      const ms = time(lang, make(1_000_000))
      if (ms > worst) { worst = ms; worstShape = shape }
    }
    check(`${lang}: worst 1 MB shape ${worst.toFixed(0)} ms (${worstShape}) < 3000`, worst < 3000)
  }
}

console.log('\n-- Solidity: each regex stays under 200 ms on adversarial 200 KB inputs --')
{
  const fill = (unit: string) => unit.repeat(Math.ceil(200_000 / unit.length)).slice(0, 200_000)
  const shapes = {
    'pragma-only': fill('pragma solidity ^0.4.24;\n'),
    'unterminated pragma': 'pragma solidity ^0.4.24 ' + fill('x'),
    'long arithmetic-free line': 'pragma solidity ^0.4.24; ' + fill('x'),
    'unterminated call options': fill('.call{ '),
    'unterminated conditions': fill('require('),
    'unterminated function parameters': 'contract Example { function f(' + fill('uint '),
    'unterminated contract headers': fill('contract Example '),
  }
  const patterns = Object.values<string[]>(classes.sink_patterns.solidity).flat().map(source => new RegExp(source, 'm'))
  patterns.push(SOLIDITY_ARITHMETIC)
  let worst = 0
  for (const [shape, input] of Object.entries(shapes)) {
    patterns.forEach((pattern, index) => {
      const start = performance.now()
      pattern.test(input)
      const ms = performance.now() - start
      worst = Math.max(worst, ms)
      check(`solidity regex ${index}: ${shape} ${ms.toFixed(1)} ms < 200`, ms < 200)
    })
    const start = performance.now()
    solidityStructuralSignals(input)
    const ms = performance.now() - start
    check(`solidity structural pass: ${shape} ${ms.toFixed(1)} ms < 500`, ms < 500)
  }
  console.log(`  Worst Solidity regex: ${worst.toFixed(1)} ms`)
}

// ---------------------------------------------------------------------------
console.log('\n-- detectAllSignalsFromList --')
await initSymbolParsers()
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signals-test-')))
try {
  const write = (rel: string, src: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), src)
  }
  const files: Record<string, string> = {
    // JS/TS on the original detectors
    'routes/login.ts': [
      "import { type Request, type Response, type NextFunction } from 'express'",
      "import * as security from '../lib/insecurity'",
      "import * as models from '../models/index'",
      '',
      'export function login () {',
      '  return (req: Request, res: Response, next: NextFunction) => {',
      "    models.sequelize.query(`SELECT * FROM Users WHERE email = '${req.body.email || ''}'`)",
      '      .then((u) => { res.json({ token: security.authorize(u) }) })',
      '      .catch((error: Error) => { next(error) })',
      '  }',
      '}',
    ].join('\n'),
    'lib/handlers.js': "const fs = require('fs')\nfunction getFile (req, res) {\n  res.sendFile(req.query.name)\n}\nmodule.exports = { getFile }\n",
    'frontend/src/app/search.component.ts': [
      "import { DomSanitizer } from '@angular/platform-browser'",
      'export class SearchComponent {',
      '  constructor (private readonly sanitizer: DomSanitizer) {}',
      '  show (q: string) {',
      '    this.searchValue = this.sanitizer.bypassSecurityTrustHtml(q)',
      '  }',
      '}',
    ].join('\n'),
    'config/default.yml': 'application:\n  name: shop\nsession:\n  secret: x\n',
    // the six languages on sink patterns
    'app/views.py': 'def show_user(request):\n    return None\n',
    'app/models.py': 'from django.db import models\n\nclass User(models.Model):\n    email = models.EmailField()\n',
    'app/settings.py': 'SECRET_KEY = "x"\n',
    'app/big.py': 'result = eval(expr)\n',
    // another language: only symbol-table exports set route_handler
    'src/Routes.kt': '// export function show_user\nfun other() {}\n',
    'src/Handlers.kt': 'fun show_user() {\n}\n',
    // manifests and lockfiles
    'package.json': '{"name": "x"}',
    'requirements.txt': 'flask==3.0\n',
    'Gemfile': "source 'https://rubygems.org'\ngem 'rails'\n",
    'Cargo.toml': '[package]\nname = "x"\n',
    'go.mod': 'module example.com/x\n',
    'Cargo.lock': '# lock\n',
    'pyproject.toml': '[project]\nname = "x"\n',
    // empty
    'empty/requirements.txt': '',
    'empty/config.py': '',
    'empty/app.ts': '\n  \n',
  }
  for (const [rel, src] of Object.entries(files)) write(rel, src)

  const parsed: Record<string, FileSymbols> = {}
  for (const rel of ['routes/login.ts', 'lib/handlers.js', 'frontend/src/app/search.component.ts', 'app/views.py', 'src/Handlers.kt']) {
    const lang = rel.endsWith('.ts') ? 'typescript' : rel.endsWith('.js') ? 'javascript' : rel.endsWith('.py') ? 'python' : 'kotlin'
    parsed[rel] = extractFileSymbols(files[rel], lang, rel)!
  }
  const symbols: SymbolTableArtifact = {
    schema_version: 1, generated_at: '', target_dir: root,
    parser: { runtime: 'test', grammars: 'test' }, languages: {}, skipped: {}, files: parsed,
  }
  const entry = (p: string, language: string, flags: { oversize?: boolean; empty?: boolean } = {}) =>
    ({ path: p, language, oversize: flags.oversize ?? false, empty: flags.empty ?? false })
  const entries = [
    entry('routes/login.ts', 'typescript'),
    entry('lib/handlers.js', 'javascript'),
    entry('frontend/src/app/search.component.ts', 'typescript'),
    entry('config/default.yml', 'yaml'),
    entry('app/views.py', 'python'),
    entry('app/models.py', 'python'),
    entry('app/settings.py', 'python'),
    entry('app/big.py', 'python', { oversize: true }),
    entry('src/Routes.kt', 'kotlin'),
    entry('src/Handlers.kt', 'kotlin'),
    entry('package.json', 'json'),
    entry('requirements.txt', 'manifest'),
    entry('Gemfile', 'manifest'),
    entry('Cargo.toml', 'toml'),
    entry('go.mod', 'manifest'),
    entry('Cargo.lock', 'manifest'),
    entry('pyproject.toml', 'toml'),
    entry('requirements-dev.txt', 'manifest', { oversize: true }),
    entry('empty/requirements.txt', 'manifest', { empty: true }),
    entry('empty/config.py', 'python', { empty: true }),
    entry('empty/app.ts', 'typescript', { empty: true }),
    entry('missing/gone.py', 'python'),
  ]
  const rh = new Set(['login', 'getFile', 'show', 'show_user'])
  const withSym = detectAllSignalsFromList(root, entries, rh, symbols).files
  const noSym = detectAllSignalsFromList(root, entries, rh).files
  const eq = (a: Signal[] | undefined, b: Signal[]) => JSON.stringify(a) === JSON.stringify(b)

  check('every entry gets a key', entries.every((e) => e.path in withSym) && Object.keys(withSym).length === entries.length)
  check('unreadable file -> [] (still keyed)', eq(withSym['missing/gone.py'], []))

  console.log('   JS/TS and other languages: original detectors')
  check('Juice-Shop-style route file', eq(withSym['routes/login.ts'], ['route_handler', 'db_query', 'auth_check']))
  check('...same without the symbol table (regex export)', eq(noSym['routes/login.ts'], ['route_handler', 'db_query', 'auth_check']))
  check('CommonJS export is a route_handler via the symbol table', eq(withSym['lib/handlers.js'], ['route_handler', 'file_io']))
  check('...which the regex alone misses', eq(noSym['lib/handlers.js'], ['file_io']))
  check('class method named like a handler is not a route_handler', eq(withSym['frontend/src/app/search.component.ts'], ['html_sink']))
  check('yaml content detectors unchanged', eq(withSym['config/default.yml'], ['auth_check']))

  console.log('   the six languages: sink patterns')
  check('python: route_handler from a symbol-table export', eq(withSym['app/views.py'], ['route_handler']))
  check('python: no symbols, no route pattern -> nothing', eq(noSym['app/views.py'], []))
  check('python: content signals from sink patterns only', eq(withSym['app/models.py'], ['model_schema']))
  check('python: path-based config_file first and alone', eq(withSym['app/settings.py'], ['config_file']))
  check('kotlin: the JS regex is not applied to other languages', eq(withSym['src/Routes.kt'], []))
  check('kotlin: symbol-table export sets route_handler', eq(withSym['src/Handlers.kt'], ['route_handler']))

  console.log('   manifests')
  for (const m of ['package.json', 'requirements.txt', 'Gemfile', 'Cargo.toml', 'go.mod', 'Cargo.lock', 'pyproject.toml']) {
    check(`dep_manifest: ${m}`, eq(withSym[m], ['dep_manifest']))
  }

  console.log('   oversize and empty')
  check('oversize: content never read', eq(withSym['app/big.py'], []))
  check('oversize: path-based signals still apply', eq(withSym['requirements-dev.txt'], ['dep_manifest']))
  check('empty manifest: no signals', eq(withSym['empty/requirements.txt'], []))
  check('empty config file: no signals', eq(withSym['empty/config.py'], []))
  check('whitespace-only file: no signals', eq(withSym['empty/app.ts'], []))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
