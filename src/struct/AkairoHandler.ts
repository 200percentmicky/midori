import { Collection } from "discord.js";
import EventEmitter from "node:events";
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { AkairoError } from "../util/AkairoError.js";
import { Category } from "../util/Category.js";
import { AkairoHandlerEvents } from "../util/Constants.js";
import { isArrayOf } from "../util/Util.js";
import type { AkairoClient } from "./AkairoClient.js";
import { AkairoModule } from "./AkairoModule.js";

export type Class<T> = abstract new (...args: any[]) => T;

/**
 * Base class for handling modules.
 */
export class AkairoHandler<
	Module extends AkairoModule<Handler, Module>,
	Handler extends AkairoHandler<Module, Handler>
> extends EventEmitter {
	/**
	 * Whether or not to automate category names.
	 */
	public declare automateCategories: boolean;

	/**
	 * Categories, mapped by ID to Category.
	 */
	public declare categories: Collection<string, Category<string, Module>>;

	/**
	 * Class to handle.
	 */
	public declare classToHandle: Class<Module>;

	/**
	 * The Akairo client.
	 */
	public declare client: AkairoClient;

	/**
	 * The main directory to modules.
	 */
	public declare directory: string;

	/**
	 * File extensions to load.
	 */
	public declare extensions: Set<string>;

	/**
	 * Function that filters files when loading.
	 */
	public declare loadFilter: LoadPredicate;

	/**
	 * Modules loaded, mapped by ID to AkairoModule.
	 */
	public declare modules: Collection<string, Module>;

	/**
	 * @param client - The Akairo client.
	 * @param options - Options for module loading and handling.
	 */
	public constructor(client: AkairoClient, options: AkairoHandlerOptions<Module, Handler>) {
		const {
			directory,
			classToHandle = AkairoModule,
			extensions = [".js", ".json", ".ts"],
			automateCategories = false,
			loadFilter = () => true
		} = options ?? {};

		if (typeof directory !== "string") throw new TypeError("options.directory must be a string.");
		if (classToHandle !== AkairoModule && !(classToHandle.prototype instanceof AkairoModule))
			throw new TypeError("options.classToHandle must be a class that extends AkairoModule.");
		if (!(extensions instanceof Set) && !isArrayOf(extensions, "string"))
			throw new TypeError("options.extensions must be an array of strings or a Set.");
		if (typeof automateCategories !== "boolean") throw new TypeError("options.automateCategories must be a boolean.");
		if (typeof loadFilter !== "function") throw new TypeError("options.loadFilter must be a function.");

		super();

		this.client = client;
		this.directory = directory;
		this.classToHandle = <Class<Module>>classToHandle;
		this.extensions = new Set(extensions);
		this.automateCategories = automateCategories;
		this.loadFilter = loadFilter;
		this.modules = new Collection();
		this.categories = new Collection();
	}

	/**
	 * Deregisters a module.
	 * @param mod - Module to use.
	 */
	public deregister(mod: Module): void {
		if (mod.filepath) delete require.cache[require.resolve(mod.filepath)];
		this.modules.delete(mod.id);
		mod.category!.delete(mod.id);
	}

	/**
	 * Finds a category by name.
	 * @param name - Name to find with.
	 */
	public findCategory(name: string): Category<string, Module> | undefined {
		return this.categories.find(category => {
			return category.id.toLowerCase() === name.toLowerCase();
		});
	}

	/**
	 * Loads a module, can be a module class or a filepath.
	 * @param thing - Module class or path to module.
	 * @param isReload - Whether this is a reload or not.
	 */
	public async load(thing: string | Module, isReload = false): Promise<Module | undefined> {
		const isClass = typeof thing === "function";
		if (!isClass && !this.extensions.has(extname(thing as string))) return undefined;

		let mod = isClass
			? thing
			: function findExport(this: any, m: any): any {
					if (!m) return null;
					if (m.prototype instanceof this.classToHandle) return m;
					return m.default ? findExport.call(this, m.default) : null;
			  }.call(this, await eval(`import(${JSON.stringify(pathToFileURL(thing as string).toString())})`));

		if (mod && mod.prototype instanceof this.classToHandle) {
			mod = new mod(this); // eslint-disable-line new-cap
		} else {
			if (!isClass) delete require.cache[require.resolve(thing as string)];
			return undefined;
		}

		if (this.modules.has(mod.id)) throw new AkairoError("ALREADY_LOADED", this.classToHandle.name, mod.id);
		this.register(mod, isClass ? null! : (thing as string));
		this.emit(AkairoHandlerEvents.LOAD, mod, isReload);
		return mod;
	}

	/**
	 * Reads all modules from a directory and loads them.
	 * @param directory - Directory to load from.
	 * Defaults to the directory passed in the constructor.
	 * @param filter - Filter for files, where true means it should be loaded.
	 * Defaults to the filter passed in the constructor.
	 */
	public async loadAll(
		directory: string = this.directory!,
		filter: LoadPredicate = this.loadFilter || (() => true)
	): Promise<this> {
		const filepaths = AkairoHandler.readdirRecursive(directory);
		const promises = [];
		for (let filepath of filepaths) {
			filepath = resolve(filepath);
			if (filter(filepath)) promises.push(this.load(filepath));
		}

		await Promise.all(promises);
		return this;
	}

	/**
	 * Registers a module.
	 * @param mod - Module to use.
	 * @param filepath - Filepath of module.
	 */
	public register(mod: Module, filepath?: string): void {
		mod.filepath = filepath!;
		mod.client = this.client;
		mod.handler = <Handler>(<unknown>this);
		this.modules.set(mod.id, mod);

		if (mod.categoryID === "default" && this.automateCategories) {
			const dirs = dirname(filepath!).split(sep);
			mod.categoryID = dirs[dirs.length - 1];
		}

		if (!this.categories.has(mod.categoryID)) {
			this.categories.set(mod.categoryID, new Category(mod.categoryID));
		}

		const category = this.categories.get(mod.categoryID)!;
		mod.category = category;
		category.set(mod.id, mod);
	}

	/**
	 * Reloads a module.
	 * @param id - ID of the module.
	 */
	public async reload(id: string): Promise<Module | undefined> {
		const mod = this.modules.get(id.toString());
		if (!mod) throw new AkairoError("MODULE_NOT_FOUND", this.classToHandle.name, id);
		if (!mod.filepath) throw new AkairoError("NOT_RELOADABLE", this.classToHandle.name, id);

		this.deregister(mod);

		const filepath = mod.filepath;
		const newMod = await this.load(filepath, true);
		return newMod;
	}

	/**
	 * Reloads all modules.
	 */
	public async reloadAll(): Promise<this> {
		const promises = [];
		for (const m of Array.from(this.modules.values())) {
			if (m.filepath) promises.push(this.reload(m.id));
		}

		await Promise.all(promises);
		return this;
	}

	/**
	 * Removes a module.
	 * @param id - ID of the module.
	 */
	public remove(id: string): Module {
		const mod = this.modules.get(id.toString());
		if (!mod) throw new AkairoError("MODULE_NOT_FOUND", this.classToHandle.name, id);

		this.deregister(mod);

		this.emit(AkairoHandlerEvents.REMOVE, mod);
		return mod;
	}

	/**
	 * Removes all modules.
	 */
	public removeAll(): this {
		for (const m of Array.from(this.modules.values())) {
			if (m.filepath) this.remove(m.id);
		}

		return this;
	}

	/**
	 * Reads files recursively from a directory.
	 * @param directory - Directory to read.
	 */
	public static readdirRecursive(directory: string): string[] {
		const result = [];

		(function read(dir) {
			const files = readdirSync(dir);

			for (const file of files) {
				const filepath = join(dir, file);

				if (statSync(filepath).isDirectory()) {
					read(filepath);
				} else {
					result.push(filepath);
				}
			}
		})(directory);

		return result;
	}
}

/**
 * Function for filtering files when loading.
 * True means the file should be loaded.
 * @param filepath - Filepath of file.
 */
export type LoadPredicate = (filepath: string) => boolean;

/**
 * Options for module loading and handling.
 */
export interface AkairoHandlerOptions<
	Module extends AkairoModule<Handler, Module>,
	Handler extends AkairoHandler<Module, Handler>
> {
	/**
	 * Whether or not to set each module's category to its parent directory name.
	 * @default false
	 */
	automateCategories?: boolean;

	/**
	 * Only classes that extends this class can be handled.
	 * @default AkairoModule
	 */
	classToHandle?: Class<Module>;

	/**
	 * Directory to modules.
	 */
	directory: string;

	/**
	 * File extensions to load.
	 * @default [".js", ".json", ".ts"]
	 */
	extensions?: string[] | Set<string>;

	/**
	 * Filter for files to be loaded.
	 * Can be set individually for each handler by overriding the `loadAll` method.
	 * @default () => true
	 */
	loadFilter?: LoadPredicate;
}
